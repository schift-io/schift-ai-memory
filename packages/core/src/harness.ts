/** 하네스 어댑터 레지스트리 — 설치 대상을 하드코딩하지 않는다.
 *
 * **왜 DI 인가**: 지금은 Claude Code 와 Codex 뿐이지만 Orca 등이 계속 늘어난다.
 * 설치 경로와 훅 스키마를 CLI 안에 박아두면 하네스가 하나 늘 때마다 설치·doctor·
 * 제거 세 군데를 같이 고쳐야 하고, 그중 하나를 빠뜨리면 "깔았는데 안 도는" 상태가
 * 조용히 생긴다(오늘 실제로 겪은 실패 모드다).
 *
 * 어댑터 하나가 자기 경로·스키마·감지 방법을 전부 소유하고, 나머지 코드는
 * 레지스트리만 본다. 하네스 추가 = 어댑터 파일 하나 + `registerHarness` 한 줄.
 *
 * **경로를 추측하지 않는다**: 어댑터는 실제 디스크/환경을 보고 detect 하며,
 * 못 찾으면 `null` 을 돌려준다. 안 깔린 하네스에 설정 파일을 만들어 두면 그 자체가
 * 사고다(남의 홈에 우리 디렉터리가 생긴다).
 */

export type HarnessScope = "user" | "project";

export interface HarnessDetection {
  /** 설정 루트(예: ~/.claude, ~/.codex). 실제로 존재가 확인된 경로다. */
  configRoot: string;
  /** 훅을 기록할 파일의 절대 경로. */
  hooksFile: string;
  /** 무엇을 근거로 찾았는지 — doctor 가 사람에게 보여준다. */
  evidence: string;
}

/** 하네스가 무엇을 했는지를 담는 **공통 계약**.
 *
 * 하네스마다 훅 payload 와 트랜스크립트 형식이 다르다. 그 차이를 어댑터가 흡수해
 * 여기로 정규화하고, 서버는 이 한 가지 모양만 받는다. 서버에 하네스별 분기가
 * 생기면 하네스가 늘 때마다 서버·클라이언트를 같이 고쳐야 한다.
 *
 * **없는 값은 넣지 않는다.** 0 으로 채우면 "안 했다"와 "못 읽었다"가 같아져서
 * 수신측 집계가 조용히 틀어진다(2026-08-05 cost_krw 가 0 으로 굳은 것과 같은 축).
 */
export interface NormalizedActivity {
  /** 세션 누적 사용량. */
  usage?: {
    model?: string;
    input_tokens?: number;
    output_tokens?: number;
    cached_input_tokens?: number;
    total_tokens?: number;
    cost_usd?: number;
    requests?: number;
  };
  /** 어떤 도구를 몇 번 불렀나. "무슨 일을 했나"의 근거다 — 토큰만으로는
   * "얼마 썼다"까지고 "뭘 했다"가 안 나온다. 도구 **이름과 횟수만** 담고
   * 인자(파일 경로·명령어)는 담지 않는다. */
  tools?: Array<{ name: string; count: number }>;
  /** 이 세션에서 관측된 어시스턴트 턴 수. */
  turns?: number;
  /** 어디서 얻었는지 — doctor 가 "못 읽었다"를 구분하게 한다. */
  source: "hook_payload" | "transcript" | "none";
}

/** 훅이 어댑터에 넘기는 원자료. 어댑터가 필요한 것만 읽는다. */
export interface HarnessEventInput {
  /** 훅 stdin 으로 들어온 JSON. */
  payload: Record<string, unknown>;
  /** 트랜스크립트 파일을 읽어주는 함수(어댑터가 경로를 정한다). */
  readFile: (path: string) => Promise<string | null>;
}

/** 설치 시점에 호출부가 어댑터에 넘기는 값. 어댑터가 필요한 것만 골라 쓴다. */
export interface HarnessApplyContext {
  bucket: string;
  collection: string;
  uploadPolicy: string;
}

/** 하네스 하나가 자기에 관한 **모든 것**을 소유한다.
 *
 * 호출부(install / doctor / uninstall)에 `if (harness === "claude")` 같은 분기가
 * 하나라도 생기면 이 인터페이스가 부족한 것이다. 그 분기는 하네스가 늘 때마다
 * 세 군데로 번지고, 그중 하나를 빠뜨리면 "깔았는데 안 도는" 상태가 조용히 생긴다.
 * 새 하네스를 붙일 때 **이 파일 밖은 건드릴 일이 없어야** 한다.
 */
export interface HarnessAdapter {
  /** 안정 식별자. 설정·리포트의 키로 쓰이므로 바꾸지 않는다. */
  id: string;
  displayName: string;
  /** 이 하네스에 설치할 lifecycle 이벤트와 훅 서브커맨드. */
  events: ReadonlyArray<{ event: string; command: string }>;
  /**
   * 이 호스트에 실제로 깔려 있는지 본다. 없으면 null.
   * 부작용을 내지 않는다 — 디렉터리를 만들지 않는다.
   */
  detect(scope: HarnessScope, cwd: string, home: string): HarnessDetection | null;
  /**
   * 현재 설정을 받아 우리 훅이 반영된 설정을 돌려준다. **남의 설정은 보존한다.**
   * 파일 스키마가 하네스마다 다르므로(Claude 는 settings.json 에 env 도 같이 살고,
   * Codex 는 훅 전용 파일) 이 변환을 어댑터가 소유한다.
   */
  applyHooks(current: Record<string, unknown>, ctx: HarnessApplyContext): Record<string, unknown>;
  /** 설정에서 우리 훅이 걸린 이벤트 목록. doctor 의 "설치됨" 판정 근거. */
  readInstalledEvents(current: Record<string, unknown>): string[];
  /** 우리 훅만 걷어낸 설정. */
  removeHooks(current: Record<string, unknown>): Record<string, unknown>;
  /**
   * 이 하네스의 훅 payload / 트랜스크립트를 **공통 계약**으로 정규화한다.
   * 하네스별 키 이름·파일 형식을 아는 것은 어댑터뿐이다.
   */
  normalize(input: HarnessEventInput): Promise<NormalizedActivity>;
}

const registry = new Map<string, HarnessAdapter>();

export function registerHarness(adapter: HarnessAdapter): void {
  registry.set(adapter.id, adapter);
}

export function getHarness(id: string): HarnessAdapter | undefined {
  return registry.get(id);
}

export function listHarnesses(): HarnessAdapter[] {
  return [...registry.values()];
}

export interface DetectedHarness {
  adapter: HarnessAdapter;
  detection: HarnessDetection;
}

/** 이 호스트에 실제로 있는 하네스만 돌려준다. 없는 건 조용히 뺀다. */
export function detectHarnesses(
  scope: HarnessScope,
  cwd: string,
  home: string,
): DetectedHarness[] {
  const found: DetectedHarness[] = [];
  for (const adapter of registry.values()) {
    const detection = adapter.detect(scope, cwd, home);
    if (detection) found.push({ adapter, detection });
  }
  return found;
}

// ---------------------------------------------------------------------------
// 훅 병합 — Claude Code 와 Codex 가 같은 스키마를 쓴다:
//   { hooks: { <Event>: [ { hooks: [ { type, command, timeout } ] } ] } }
// ---------------------------------------------------------------------------

/** 우리가 넣은 훅에만 붙는 표식. 실제 커맨드 문자열에 들어있는 부분이어야 한다 —
 * 레포 이름 같은 걸 쓰면 매칭이 안 돼 재설치마다 훅이 중복 등록된다(실측으로 잡음). */
export const HOOK_MARKER = "@schift-io/ai-memory";

function isOurGroup(group: unknown): boolean {
  if (!group || typeof group !== "object") return false;
  const hooks = (group as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(
    (h) =>
      h &&
      typeof h === "object" &&
      typeof (h as { command?: unknown }).command === "string" &&
      (h as { command: string }).command.includes(HOOK_MARKER),
  );
}

/** 우리 그룹만 교체하고 남의 것은 그대로 둔다. 재실행해도 결과가 같다(멱등). */
export function mergeHookEvents(
  existingHooks: Record<string, unknown> | undefined,
  ours: ReadonlyArray<{ event: string; command: string }>,
  timeoutSeconds = 10,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...(existingHooks ?? {}) };
  for (const { event, command } of ours) {
    const prior = Array.isArray(merged[event]) ? (merged[event] as unknown[]) : [];
    const kept = prior.filter((group) => !isOurGroup(group));
    merged[event] = [
      ...kept,
      { hooks: [{ type: "command", command, timeout: timeoutSeconds }] },
    ];
  }
  return merged;
}

/** 설정에서 우리 훅을 걷어낸다. 이벤트가 비면 키 자체를 지운다 — 빈 배열을 남기면
 * 다음 사람이 "뭔가 설정돼 있다"고 오독한다. */
export function removeOurHooks(
  existingHooks: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [event, groups] of Object.entries(existingHooks ?? {})) {
    if (!Array.isArray(groups)) {
      result[event] = groups;
      continue;
    }
    const kept = groups.filter((group) => !isOurGroup(group));
    if (kept.length > 0) result[event] = kept;
  }
  return result;
}

/** 설정에 우리 훅이 걸린 이벤트 목록. doctor 가 "설치됨"을 판정하는 근거다. */
export function installedEvents(
  existingHooks: Record<string, unknown> | undefined,
): string[] {
  return Object.entries(existingHooks ?? {})
    .filter(([, groups]) => Array.isArray(groups) && groups.some(isOurGroup))
    .map(([event]) => event);
}
