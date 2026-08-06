/** 내구성 있는 아웃박스 — 큐에 쌓인 이벤트를 실제로 내보낸다.
 *
 * 지금까지 실패한 업로드는 큐 디렉터리에 파일로 쌓이기만 했고 **비우는 주체가
 * 없었다.** 노트북이 잠깐 오프라인이었거나 API 가 5초 흔들린 것만으로 그 세션의
 * 지출은 영구히 서버에 안 올라간다. 우리 제품 지표가 "계측 커버리지"라 이건
 * 숫자를 조용히 깎는다 — 아무 에러도 안 나면서.
 *
 * 설계 원칙 셋:
 *
 * 1. **재시도할 실패와 아닌 실패를 구분한다.** 네트워크 단절·5xx 는 기다리면
 *    낫는다. 401/403(키 폐기)·400/422(형식 오류)는 여덟 번을 더 보내도 같은
 *    답이 온다 — 그건 즉시 격리해서 사람이 보게 한다. 이 구분이 없으면
 *    폐기된 키로 큐 전체를 계속 두드리다가 rate limit 에 걸린다.
 * 2. **동시에 뜬 훅 둘이 같은 이벤트를 두 번 보내지 않는다.** 훅은 세션마다
 *    프로세스로 뜨므로 여러 개가 겹친다. 리스 파일을 `wx`(배타 생성)로 잡아
 *    한 번에 하나만 가져간다.
 * 3. **버리지 않는다.** 포기한 것은 지우는 대신 `quarantine/` 으로 옮긴다.
 *    지워버리면 "왜 안 올라왔나"를 나중에 물을 수 없다.
 */

import { mkdir, open, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 배달 시도 결과. status 0 은 네트워크 자체가 안 된 경우다. */
export interface DeliveryResult {
  ok: boolean;
  status: number;
  error?: string;
}

export interface OutboxItemState {
  attempts: number;
  /** 이 시각 전에는 다시 시도하지 않는다(ISO8601). */
  next_attempt_at: string;
  last_error?: string;
  last_status?: number;
}

export interface OutboxItem {
  /** 큐 파일 이름(확장자 포함). */
  name: string;
  path: string;
  state: OutboxItemState;
}

export interface DrainOptions {
  /** 이번 실행에서 최대 몇 건까지 보낼지. 훅에서 부를 때 세션을 붙잡지 않게 한다. */
  limit?: number;
  /** 이 횟수만큼 실패하면 격리한다. */
  maxAttempts?: number;
  /** 첫 재시도까지의 대기(ms). 이후 2배씩 늘어난다. */
  baseDelayMs?: number;
  /** 백오프 상한(ms). */
  maxDelayMs?: number;
  /** 리스 유효 시간(ms). 프로세스가 죽어도 이 시간이 지나면 다시 잡힌다. */
  leaseMs?: number;
  /** 테스트가 시간을 주입한다. */
  now?: () => number;
}

export interface DrainReport {
  delivered: number;
  retrying: number;
  quarantined: number;
  /** 아직 백오프 대기 중이라 이번엔 건드리지 않은 건수. */
  deferred: number;
}

const STATE_SUFFIX = ".state.json";
const LEASE_SUFFIX = ".lease";
const QUARANTINE_DIR = "quarantine";

function isEventFile(name: string): boolean {
  return (
    name.endsWith(".json") &&
    !name.endsWith(STATE_SUFFIX) &&
    // 로컬 설정이 큐 디렉터리에 같이 놓이는 경우가 있다(테스트·수동 조작).
    name !== "config.json"
  );
}

async function readState(path: string): Promise<OutboxItemState> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<OutboxItemState>;
    return {
      attempts: typeof parsed.attempts === "number" ? parsed.attempts : 0,
      next_attempt_at:
        typeof parsed.next_attempt_at === "string" ? parsed.next_attempt_at : new Date(0).toISOString(),
      last_error: typeof parsed.last_error === "string" ? parsed.last_error : undefined,
      last_status: typeof parsed.last_status === "number" ? parsed.last_status : undefined,
    };
  } catch {
    // 상태 파일이 없으면 "한 번도 안 보낸 새 이벤트"다.
    return { attempts: 0, next_attempt_at: new Date(0).toISOString() };
  }
}

/** 큐에 있는 이벤트와 각자의 배달 상태.
 *
 * 파일명이 ISO 타임스탬프로 시작하므로 **밀리초 단위로는** 오래된 것부터 나온다.
 * limit 이 걸렸을 때 오래된 이벤트가 굶지 않게 하려는 것이고, 같은 밀리초 안의
 * 순서는 보장하지 않는다(뒤는 랜덤 id 다). 배달 순서에 의미를 두는 소비자가
 * 생기면 그때 단조 카운터를 파일명에 넣어야 한다 — 지금은 필요 없다. */
export async function listOutbox(queueDir: string): Promise<OutboxItem[]> {
  let names: string[];
  try {
    names = await readdir(queueDir);
  } catch {
    return [];
  }
  const items: OutboxItem[] = [];
  for (const name of names.filter(isEventFile).sort()) {
    const path = join(queueDir, name);
    items.push({ name, path, state: await readState(`${path}${STATE_SUFFIX}`) });
  }
  return items;
}

/**
 * 이 상태 코드가 **다시 보내면 나아질 실패**인가.
 *
 * 401/403 은 키가 폐기된 것이고 400/422 는 우리가 만든 payload 가 틀린 것이다.
 * 둘 다 재시도가 고치지 못한다 — 계속 두드리면 rate limit 만 먹고 진짜 재시도가
 * 필요한 이벤트가 뒤에서 굶는다. 404 는 버킷·컬렉션이 아직 없을 수 있어
 * 재시도 대상으로 남긴다.
 */
export function isRetryable(status: number): boolean {
  if (status === 0) return true; // 네트워크 자체가 안 됨
  if (status === 408 || status === 429) return true;
  if (status >= 500) return true;
  if (status === 404) return true;
  return false;
}

function backoffMs(attempts: number, base: number, max: number): number {
  return Math.min(max, base * 2 ** Math.max(0, attempts - 1));
}

/** 리스를 배타적으로 잡는다. 이미 남이 잡고 있으면 false. */
async function acquireLease(path: string, now: number, leaseMs: number): Promise<boolean> {
  const leasePath = `${path}${LEASE_SUFFIX}`;
  try {
    const handle = await open(leasePath, "wx");
    await handle.writeFile(JSON.stringify({ until: now + leaseMs }), "utf8");
    await handle.close();
    return true;
  } catch {
    // 이미 있다 — 만료됐는지 본다. 프로세스가 죽어 리스가 영원히 남는 걸 막는다.
    try {
      const held = JSON.parse(await readFile(leasePath, "utf8")) as { until?: number };
      if (typeof held.until === "number" && held.until > now) return false;
    } catch {
      // 읽을 수 없는 리스는 만료된 것으로 본다.
    }
    await writeFile(leasePath, JSON.stringify({ until: now + leaseMs }), "utf8");
    return true;
  }
}

async function releaseLease(path: string): Promise<void> {
  await unlink(`${path}${LEASE_SUFFIX}`).catch(() => undefined);
}

/** 포기한 이벤트를 격리한다. 상태 파일도 같이 옮겨 이유가 남는다. */
async function quarantine(queueDir: string, item: OutboxItem): Promise<void> {
  const dir = join(queueDir, QUARANTINE_DIR);
  await mkdir(dir, { recursive: true });
  await rename(item.path, join(dir, item.name)).catch(() => undefined);
  await rename(`${item.path}${STATE_SUFFIX}`, join(dir, `${item.name}${STATE_SUFFIX}`)).catch(
    () => undefined,
  );
}

/**
 * 큐를 비운다. 성공하면 파일을 지우고, 재시도할 실패면 백오프를 늘리고,
 * 재시도가 소용없는 실패면 격리한다.
 *
 * **호스트를 절대 실패시키지 않는다** — deliver 가 던져도 네트워크 실패로 취급한다.
 * 훅에서 부르는 함수라 여기서 예외가 새면 사용자의 세션이 깨진다.
 */
export async function drainOutbox(
  queueDir: string,
  deliver: (event: Record<string, unknown>) => Promise<DeliveryResult>,
  options: DrainOptions = {},
): Promise<DrainReport> {
  const {
    limit = 25,
    maxAttempts = 8,
    baseDelayMs = 30_000,
    maxDelayMs = 6 * 60 * 60 * 1000,
    leaseMs = 60_000,
    now = () => Date.now(),
  } = options;

  const report: DrainReport = { delivered: 0, retrying: 0, quarantined: 0, deferred: 0 };
  const items = await listOutbox(queueDir);
  let sent = 0;

  for (const item of items) {
    if (sent >= limit) break;
    const at = now();
    if (Date.parse(item.state.next_attempt_at) > at) {
      report.deferred += 1;
      continue;
    }
    if (!(await acquireLease(item.path, at, leaseMs))) continue;

    try {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(await readFile(item.path, "utf8")) as Record<string, unknown>;
      } catch (error) {
        // 읽을 수 없는 파일은 재시도해도 같다. 지우지 말고 격리한다.
        await writeFile(
          `${item.path}${STATE_SUFFIX}`,
          `${JSON.stringify({ ...item.state, last_error: String(error).slice(0, 300) }, null, 2)}\n`,
          "utf8",
        );
        await quarantine(queueDir, item);
        report.quarantined += 1;
        continue;
      }

      sent += 1;
      let result: DeliveryResult;
      try {
        result = await deliver(event);
      } catch (error) {
        result = { ok: false, status: 0, error: String(error).slice(0, 300) };
      }

      if (result.ok) {
        await unlink(item.path).catch(() => undefined);
        await unlink(`${item.path}${STATE_SUFFIX}`).catch(() => undefined);
        report.delivered += 1;
        continue;
      }

      const attempts = item.state.attempts + 1;
      const nextState: OutboxItemState = {
        attempts,
        next_attempt_at: new Date(at + backoffMs(attempts, baseDelayMs, maxDelayMs)).toISOString(),
        last_error: result.error?.slice(0, 300),
        last_status: result.status,
      };
      await writeFile(`${item.path}${STATE_SUFFIX}`, `${JSON.stringify(nextState, null, 2)}\n`, "utf8");

      if (!isRetryable(result.status) || attempts >= maxAttempts) {
        await quarantine(queueDir, { ...item, state: nextState });
        report.quarantined += 1;
      } else {
        report.retrying += 1;
      }
    } finally {
      await releaseLease(item.path);
    }
  }

  return report;
}

/** 큐 상태 요약 — doctor 가 "쌓여 있는데 아무도 안 비운다"를 보여주게 한다. */
export async function outboxStatus(
  queueDir: string,
  now: () => number = () => Date.now(),
): Promise<{
  pending: number;
  due: number;
  quarantined: number;
  oldest_pending_at?: string;
  last_error?: string;
}> {
  const items = await listOutbox(queueDir);
  const at = now();
  let quarantined = 0;
  try {
    quarantined = (await readdir(join(queueDir, QUARANTINE_DIR))).filter(isEventFile).length;
  } catch {
    quarantined = 0;
  }
  const due = items.filter((item) => Date.parse(item.state.next_attempt_at) <= at).length;
  const withError = items.filter((item) => item.state.last_error);
  return {
    pending: items.length,
    due,
    quarantined,
    oldest_pending_at: items[0]?.name.slice(0, 10) || undefined,
    last_error: withError[withError.length - 1]?.state.last_error,
  };
}
