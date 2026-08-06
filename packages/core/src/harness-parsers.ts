/** 하네스별 원자료 → 공통 계약(`NormalizedActivity`) 변환기.
 *
 * 여기가 "각 DI 로 캐치해서 양식에 맞게 넣어주는" 자리다. 하네스마다 훅 payload 와
 * 트랜스크립트 형식이 다른데, 그 차이를 아는 것은 어댑터뿐이고 서버는 정규화된
 * 한 가지 모양만 받는다. 서버에 하네스별 분기가 생기면 하네스가 늘 때마다
 * 서버·클라이언트를 같이 고쳐야 한다.
 */

import type { HarnessEventInput, NormalizedActivity } from "./harness.js";

function numberOf(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function objectOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Claude Code — 훅 payload 에는 토큰이 없다(실측: session_id / transcript_path / cwd).
 * 토큰·모델·도구 호출은 전부 트랜스크립트 JSONL 안에 있다.
 *
 * 반환은 **세션 누적**이다. Stop 은 턴마다 불리므로 매번 전체를 다시 합산하고,
 * 서버가 세션 단위로 덮어쓴다(합산이 아니라 교체). 그래야 중복 계상이 없다. */
export function parseClaudeTranscript(text: string): NormalizedActivity {
  let input = 0;
  let output = 0;
  let cached = 0;
  let turns = 0;
  let model: string | undefined;
  const tools = new Map<string, number>();

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const message = objectOf((parsed as Record<string, unknown>)?.message);
    if (!message) continue;

    // 도구 호출은 assistant 메시지의 content 블록에 있다. **이름과 횟수만** 센다 —
    // 인자(파일 경로·명령어)는 담지 않는다. 무슨 일을 했는지는 이름으로 충분하고,
    // 인자를 담는 순간 소스코드·비밀이 흘러나간다.
    const content = message.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        const b = objectOf(block);
        if (b?.type === "tool_use") {
          const name = stringOf(b.name);
          if (name) tools.set(name, (tools.get(name) ?? 0) + 1);
        }
      }
    }

    const usage = objectOf(message.usage);
    if (!usage) continue;
    turns += 1;
    input += numberOf(usage.input_tokens) ?? 0;
    // 캐시 생성분도 과금 대상이라 입력에 포함해야 실제 비용과 맞는다.
    input += numberOf(usage.cache_creation_input_tokens) ?? 0;
    output += numberOf(usage.output_tokens) ?? 0;
    cached += numberOf(usage.cache_read_input_tokens) ?? 0;
    model = stringOf(message.model) ?? model;
  }

  if (turns === 0 && tools.size === 0) return { source: "none" };

  const activity: NormalizedActivity = { source: "transcript" };
  if (turns > 0) {
    activity.turns = turns;
    activity.usage = {
      input_tokens: input,
      output_tokens: output,
      total_tokens: input + output,
      requests: turns,
    };
    if (cached > 0) activity.usage.cached_input_tokens = cached;
    if (model) activity.usage.model = model;
  }
  if (tools.size > 0) {
    activity.tools = [...tools.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
  }
  return activity;
}

/** Codex 계열 — 사용량이 훅 payload 에 직접 실려 온다. 키 이름이 버전마다 달라
 * 후보를 훑되, **없으면 필드를 만들지 않는다**. */
export function parsePayloadUsage(payload: Record<string, unknown>): NormalizedActivity {
  const raw =
    objectOf(payload.usage) ??
    objectOf(payload.token_usage) ??
    objectOf(payload.tokenUsage) ??
    objectOf(objectOf(payload.message)?.usage) ??
    {};

  const input =
    numberOf(raw.input_tokens) ?? numberOf(raw.inputTokens) ?? numberOf(raw.prompt_tokens);
  const output =
    numberOf(raw.output_tokens) ?? numberOf(raw.outputTokens) ?? numberOf(raw.completion_tokens);
  const cached =
    numberOf(raw.cache_read_input_tokens) ??
    numberOf(raw.cached_input_tokens) ??
    numberOf(raw.cacheReadInputTokens);
  const model =
    stringOf(payload.model) ?? stringOf(raw.model) ?? stringOf(objectOf(payload.message)?.model);
  const cost =
    numberOf(payload.cost_usd) ?? numberOf(raw.cost_usd) ?? numberOf(payload.total_cost_usd);
  const requests = numberOf(payload.num_requests) ?? numberOf(raw.requests);

  const usage: NonNullable<NormalizedActivity["usage"]> = {};
  if (model) usage.model = model;
  if (input !== undefined) usage.input_tokens = input;
  if (output !== undefined) usage.output_tokens = output;
  if (cached !== undefined) usage.cached_input_tokens = cached;
  if (input !== undefined || output !== undefined) {
    usage.total_tokens = (input ?? 0) + (output ?? 0);
  }
  if (cost !== undefined) usage.cost_usd = cost;
  if (requests !== undefined) usage.requests = requests;

  // payload 에 도구 목록이 실려오는 하네스가 있으면 여기서 센다.
  const toolNames = Array.isArray(payload.tools_used) ? payload.tools_used : undefined;
  const tools = new Map<string, number>();
  for (const entry of toolNames ?? []) {
    const name = stringOf(entry) ?? stringOf(objectOf(entry)?.name);
    if (name) tools.set(name, (tools.get(name) ?? 0) + 1);
  }

  if (Object.keys(usage).length === 0 && tools.size === 0) return { source: "none" };
  const activity: NormalizedActivity = { source: "hook_payload" };
  if (Object.keys(usage).length > 0) activity.usage = usage;
  if (tools.size > 0) {
    activity.tools = [...tools.entries()].map(([name, count]) => ({ name, count }));
  }
  return activity;
}

/** payload 우선, 없으면 트랜스크립트. 어댑터가 이 조합을 골라 쓴다. */
export async function normalizeWithTranscriptFallback(
  input: HarnessEventInput,
  transcriptKeys: readonly string[],
  parseTranscript: (text: string) => NormalizedActivity,
): Promise<NormalizedActivity> {
  const fromPayload = parsePayloadUsage(input.payload);
  if (fromPayload.source !== "none") return fromPayload;

  for (const key of transcriptKeys) {
    const path = stringOf(input.payload[key]);
    if (!path) continue;
    const text = await input.readFile(path);
    if (text === null) continue;
    return parseTranscript(text);
  }
  return { source: "none" };
}
