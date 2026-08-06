/** 기본 하네스 어댑터들.
 *
 * **하네스를 하나 추가하려면 이 파일만 고친다.** 설치·doctor·제거는 레지스트리를
 * 통해 자동으로 그 하네스를 포함한다 — 호출부에 분기를 추가할 일이 없다.
 *
 * 새 하네스 추가 절차:
 *   1. `defineJsonHookHarness({...})` 로 어댑터를 만든다(훅 스키마가 같은 경우).
 *      스키마가 다르면 `HarnessAdapter` 를 직접 구현한다 — 인터페이스가 그걸 허용한다.
 *   2. `registerDefaultHarnesses()` 안에 `registerHarness(...)` 한 줄.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  normalizeWithTranscriptFallback,
  parseClaudeTranscript,
  parsePayloadUsage,
} from "./harness-parsers.js";
import {
  installedEvents,
  mergeHookEvents,
  registerHarness,
  removeOurHooks,
  type HarnessAdapter,
  type HarnessApplyContext,
  type HarnessEventInput,
  type NormalizedActivity,
  type HarnessDetection,
  type HarnessScope,
} from "./harness.js";

/** 계측에 필요한 lifecycle. Stop 에서 세션 누적 사용량을 보내고 SessionEnd 로 마감한다.
 * 더 촘촘한 이벤트(PreToolUse 등)는 payload 대비 가치가 낮아 넣지 않는다 — 훅 하나가
 * 늘 때마다 사용자 세션에 프로세스가 하나씩 더 뜬다. */
/** 계획(.omx/plans/2026-08-06-omx-hook-gap-periodic-sync.md)이 강제로 요구하는 lifecycle.
 * 각 훅이 하는 일이 다르다:
 *   SessionStart — 설치·인증·정책·큐 상태 확인(그리고 opportunistic flush)
 *   PreCompact/PostCompact — 세션 메모리 생성 및 candidate 등록
 *   Stop/SessionEnd — 요약·usage·outbox flush
 * PostToolUse 는 아직 넣지 않는다: 턴마다 프로세스가 뜨는 비용이 크고,
 * 도구 호출은 트랜스크립트에서 세션 단위로 이미 집계된다. */
const LIFECYCLE = [
  { event: "SessionStart", suffix: "session-start" },
  { event: "PreCompact", suffix: "pre-compact" },
  { event: "PostCompact", suffix: "post-compact" },
  { event: "Stop", suffix: "stop" },
  { event: "SessionEnd", suffix: "session-end" },
] as const;

export interface JsonHookHarnessSpec {
  id: string;
  displayName: string;
  /** 홈 아래 설정 디렉터리 이름(예: ".claude"). */
  configDirName: string;
  /** 훅이 저장되는 파일 이름(예: "settings.json", "hooks.json"). */
  hooksFileName: string;
  /** 훅 커맨드 접두사 — `<prefix>-stop` 형태로 서브커맨드가 된다. */
  commandPrefix: string;
  /** 설정 경로를 덮어쓰는 환경변수 이름. */
  configDirEnv?: string;
  /**
   * 이 하네스의 설정 파일이 훅 외에 런타임 env 도 담는가.
   * Claude 의 settings.json 은 담고, Codex 의 hooks.json 은 안 담는다 —
   * 안 담는 파일에 env 를 넣으면 그 파일 스키마를 오염시킨다.
   */
  carriesEnv?: boolean;
  /** 트랜스크립트 경로가 payload 의 어느 키에 오는가. 비면 payload 만 본다. */
  transcriptKeys?: readonly string[];
  /** 트랜스크립트 본문 파서. 하네스마다 형식이 다르다. */
  parseTranscript?: (text: string) => NormalizedActivity;
}

/** 훅 스키마가 `{ hooks: { <Event>: [{ hooks: [...] }] } }` 인 하네스용 팩토리.
 * Claude Code 와 Codex 가 이 스키마를 공유한다. */
export function defineJsonHookHarness(spec: JsonHookHarnessSpec): HarnessAdapter {
  return {
    id: spec.id,
    displayName: spec.displayName,
    events: LIFECYCLE.map(({ event, suffix }) => ({
      event,
      command: `npx -y @schift-io/ai-memory-hooks ${spec.commandPrefix}-${suffix}`,
    })),

    detect(scope: HarnessScope, cwd: string, home: string): HarnessDetection | null {
      const override = spec.configDirEnv ? process.env[spec.configDirEnv]?.trim() : undefined;
      // env 오버라이드가 최우선이다 — 사용자가 명시한 경로를 무시하면 설치가 엉뚱한 데로 간다.
      if (override) {
        return {
          configRoot: override,
          hooksFile: join(override, spec.hooksFileName),
          evidence: `${spec.configDirEnv} override`,
        };
      }
      if (scope === "project") {
        // 프로젝트 스코프는 "이 레포에 넣겠다"는 명시적 의사표시라 없으면 만든다.
        const root = join(cwd, spec.configDirName);
        return {
          configRoot: root,
          hooksFile: join(root, spec.hooksFileName),
          evidence: "project scope",
        };
      }
      const root = join(home, spec.configDirName);
      // **존재를 확인하고서만** 반환한다. 안 깔린 하네스에 디렉터리를 만들지 않는다.
      if (!existsSync(root)) return null;
      return {
        configRoot: root,
        hooksFile: join(root, spec.hooksFileName),
        evidence: `${root} exists`,
      };
    },

    applyHooks(current: Record<string, unknown>, ctx: HarnessApplyContext) {
      const next: Record<string, unknown> = {
        ...current,
        hooks: mergeHookEvents(current.hooks as Record<string, unknown> | undefined, this.events),
      };
      if (spec.carriesEnv) {
        next.env = {
          ...((current.env ?? {}) as Record<string, unknown>),
          SCHIFT_COMPANY_BUCKET: ctx.bucket,
          SCHIFT_COLLECTION: ctx.collection,
          SCHIFT_AI_MEMORY_POLICY: ctx.uploadPolicy,
          SCHIFT_AI_MEMORY_UPLOAD: "1",
        };
      }
      return next;
    },

    readInstalledEvents(current: Record<string, unknown>) {
      return installedEvents(current.hooks as Record<string, unknown> | undefined);
    },

    async normalize(input: HarnessEventInput): Promise<NormalizedActivity> {
      if (spec.transcriptKeys && spec.parseTranscript) {
        return normalizeWithTranscriptFallback(input, spec.transcriptKeys, spec.parseTranscript);
      }
      return parsePayloadUsage(input.payload);
    },

    removeHooks(current: Record<string, unknown>) {
      const hooks = removeOurHooks(current.hooks as Record<string, unknown> | undefined);
      const next = { ...current };
      // 훅이 하나도 안 남으면 키를 지운다 — 빈 객체를 남기면 다음 사람이
      // "뭔가 설정돼 있다"고 오독한다.
      if (Object.keys(hooks).length === 0) delete next.hooks;
      else next.hooks = hooks;
      return next;
    },
  };
}

export const claudeCodeAdapter = defineJsonHookHarness({
  id: "claude-code",
  displayName: "Claude Code",
  configDirName: ".claude",
  hooksFileName: "settings.json",
  commandPrefix: "claude",
  configDirEnv: "CLAUDE_CONFIG_DIR",
  carriesEnv: true,
  transcriptKeys: ["transcript_path", "transcriptPath"],
  parseTranscript: parseClaudeTranscript,
});

/** Codex — 훅이 settings 가 아니라 **별도 hooks.json** 에 산다.
 * 스키마는 같지만 파일이 다르고 env 를 담지 않는다. 그 차이를 spec 이 흡수한다. */
export const codexAdapter = defineJsonHookHarness({
  id: "codex",
  displayName: "Codex",
  configDirName: ".codex",
  hooksFileName: "hooks.json",
  commandPrefix: "codex",
  configDirEnv: "CODEX_HOME",
  carriesEnv: false,
});

let registered = false;

/** 기본 어댑터를 등록한다. 여러 번 불러도 안전하다. */
export function registerDefaultHarnesses(): void {
  if (registered) return;
  registerHarness(claudeCodeAdapter);
  registerHarness(codexAdapter);
  registered = true;
}
