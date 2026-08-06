#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import {
  atomicWriteJson,
  createAiMemoryEvent,
  detectHarnesses,
  installedEvents,
  listHarnesses,
  mergeHookEvents,
  registerDefaultHarnesses,
} from "@schift-io/ai-memory-core";

const CODING_AGENT_ROLE_PACKAGE_ID = "schift.coding-agent.default";

function argValue(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function printHelp() {
  console.log(`schift-ai-memory

Usage:
  schift-ai-memory init [--print] [--no-login] [--bucket <company-bucket>]
  schift-ai-memory login [--bucket default] [--collection __schift_ai_daily_log]
  schift-ai-memory doctor
  schift-ai-memory status
  schift-ai-memory me
  schift-ai-memory codex-marketplace
  schift-ai-memory install [--scope project|user] [--harness <id>] [--dry-run]
                          [--output <hooks-file>]
  schift-ai-memory uninstall [--scope project|user]
  schift-ai-memory claude-code-settings [--scope project|user] [--dry-run]
  schift-ai-memory metadata-example

install detects the AI harnesses actually present on this host (Claude Code,
Codex, ...) and installs hooks into each one's own config file. Nothing is
written for a harness that is not installed. Existing non-Schift hooks are
preserved, and re-running install is idempotent.

--dry-run prints the target files without writing. --output writes the hooks to
a path you name instead of the detected one; it needs a single target, so pass
--harness <id> when more than one harness is present.

claude-code-settings is an alias for install, kept for older docs.

The default init flow connects OAuth, installs the hooks, and prints the
remaining host-specific commands. Use --print for a machine-readable plan.
`);
}

function companyBucket(): string {
  return argValue("--bucket") ?? process.env.SCHIFT_COMPANY_BUCKET ?? "default";
}

function collectionName(): string {
  return argValue("--collection") ?? process.env.SCHIFT_COLLECTION ?? "__schift_ai_daily_log";
}

/** 프로젝트 스코프 상태 디렉터리(`.schift/`). oh-my-codex 의 `.omx/` 와 같은 자리다.
 *
 * 왜 필요한가: 지금은 상태가 `~/.schift/ai-memory/` 하나뿐이라 **레포마다 다른 설정을
 * 가질 수 없다**. 회사 레포와 개인 레포가 같은 버킷으로 섞이고, 어떤 스코프로 설치했는지
 * 기록이 없어 재실행 결과가 예측 불가능하다. */
function projectStateDir(): string {
  return join(process.cwd(), ".schift");
}

function setupScopePath(): string {
  return join(projectStateDir(), "setup-scope.json");
}

/** 스코프 결정: `--scope project|user`. 명시 안 하면 프로젝트에 기록이 있으면 project,
 * 없으면 user. **추측해서 프로젝트 파일을 만들지 않는다** — 남의 레포에 우리 디렉터리가
 * 조용히 생기면 그게 먼저 사고다. */
async function resolveScope(): Promise<"project" | "user"> {
  const explicit = argValue("--scope");
  if (explicit === "project" || explicit === "user") return explicit;
  try {
    await readFile(setupScopePath(), "utf8");
    return "project";
  } catch {
    return "user";
  }
}

async function writeSetupScope(scope: "project" | "user"): Promise<void> {
  if (scope !== "project") return;
  await atomicWriteJson(setupScopePath(), {
    scope,
    bucket: companyBucket(),
    collection: collectionName(),
    recorded_at: new Date().toISOString(),
  });
}

function addHours(date: Date, hours: number): string {
  return new Date(date.getTime() + hours * 60 * 60 * 1000).toISOString();
}

function apiBaseUrl(): string {
  return process.env.SCHIFT_API_BASE_URL ?? "https://api.schift.io";
}

function appBaseUrl(): string {
  return process.env.SCHIFT_APP_BASE_URL ?? "https://schift.io";
}

function configPath(): string {
  return process.env.SCHIFT_AI_MEMORY_CONFIG ?? join(homedir(), ".schift", "ai-memory", "config.json");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function readLocalConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(configPath(), "utf8")) as Record<string, unknown>;
}

function configIdentity(config: Record<string, unknown>) {
  const identity = config.identity && typeof config.identity === "object"
    ? config.identity as Record<string, unknown>
    : {};
  return {
    org_id: stringValue(identity.org_id) ?? stringValue(config.org_id) ?? null,
    user_id: stringValue(identity.user_id) ?? stringValue(config.user_id) ?? null,
  };
}

function codexMarketplaceCommand(): string {
  return "codex plugin marketplace add schift-io/schift-ai-memory --sparse .agents/plugins";
}

function claudeCodeSettings(bucket: string) {
  return {
    hooks: {
      Stop: [
        {
          hooks: [
            {
              type: "command",
              command: "npx -y @schift-io/ai-memory-hooks claude-stop",
              timeout: 10,
              statusMessage: "Queueing Schift AI memory summary",
            },
          ],
        },
      ],
      SessionEnd: [
        {
          hooks: [
            {
              type: "command",
              command: "npx -y @schift-io/ai-memory-hooks claude-session-end",
              timeout: 10,
              statusMessage: "Queueing Schift AI memory session metadata",
            },
          ],
        },
      ],
    },
    env: {
      SCHIFT_COMPANY_BUCKET: bucket,
      SCHIFT_COLLECTION: collectionName(),
      SCHIFT_AI_MEMORY_POLICY: "summary_metadata_only",
      SCHIFT_AI_MEMORY_UPLOAD: "1",
    },
  };
}

/** 우리가 넣은 훅에만 붙는 표식. 이게 있어야 재설치·제거 때 **남의 훅을 안 건드리고**
 * 우리 것만 골라낼 수 있다. 사용자가 이미 쓰던 Stop/SessionEnd 훅이 있는 게 정상이다. */
// 실제 커맨드 문자열(`npx -y @schift-io/ai-memory-hooks ...`)에 들어 있는 부분이어야
// 한다. 패키지 스코프가 아닌 레포 이름("schift-ai-memory")을 마커로 두면 매칭이 안 돼
// 재설치할 때마다 훅이 중복 등록된다(실측으로 잡음).
const HOOK_MARKER = "@schift-io/ai-memory";

function isOurHookGroup(group: unknown): boolean {
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

function mergeHookEvent(existing: unknown, ours: unknown[]): unknown[] {
  const kept = Array.isArray(existing) ? existing.filter((g) => !isOurHookGroup(g)) : [];
  return [...kept, ...ours];
}

async function readJsonIfExists(path: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Claude Code 설정에 훅을 **실제로 설치한다**.
 *
 * 이전에는 예제 파일만 쓰고 "직접 병합하세요"라고 안내했다. 그러면 직원이
 * JSON 을 손으로 합쳐야 해서 설치가 사실상 안 된다 — 우리 제품 논리가
 * "설치 커버리지가 곧 가시성"인데 그 숫자가 안 오른다.
 *
 * 남의 설정은 보존한다: 기존 훅 그룹 중 우리 표식이 없는 것은 그대로 두고,
 * 우리 것만 교체한다. env 도 기존 키를 덮어쓰지 않고 우리 키만 얹는다. */
/** 감지된 모든 하네스에 훅을 설치한다.
 *
 * 설치 대상을 **하드코딩하지 않는다** — 어댑터 레지스트리가 이 호스트에 실제로
 * 있는 하네스만 돌려주고, 각 어댑터가 자기 경로와 훅 파일명을 안다(Claude 는
 * settings.json, Codex 는 별도 hooks.json). Orca 등이 늘면 어댑터 한 줄이면 된다.
 *
 * 안 깔린 하네스는 건드리지 않는다. 없는 홈에 우리 디렉터리를 만들어 두는 게
 * 그 자체로 사고다.
 */
async function installHarnessHooks(): Promise<number> {
  registerDefaultHarnesses();
  const scope = await resolveScope();
  const dryRun = hasFlag("--dry-run") || hasFlag("--print");
  const only = argValue("--harness");

  let detected = detectHarnesses(scope, process.cwd(), homedir());
  if (only) detected = detected.filter((d) => d.adapter.id === only);

  // `--output` 은 훅 파일 경로를 직접 지정한다(테스트·운영 스크립트용).
  // 대상이 둘 이상이면 어디에 쓸지 알 수 없으므로 **조용히 하나를 고르지 않고 멈춘다** —
  // 지정한 경로가 무시되면 사용자는 설치됐다고 믿고 엉뚱한 파일을 들여다보게 된다.
  const outputOverride = argValue("--output");
  if (outputOverride && detected.length > 1) {
    console.log(
      `[schift-ai-memory] --output needs a single target; detected: ${detected
        .map((d) => d.adapter.id)
        .join(", ")}. Pass --harness <id>.`,
    );
    return 1;
  }

  if (detected.length === 0) {
    console.log("[schift-ai-memory] no supported AI harness found on this host.");
    console.log(
      "[schift-ai-memory] looked for: " + listHarnesses().map((a) => a.displayName).join(", "),
    );
    console.log("[schift-ai-memory] install one, or pass --scope project to set this repo up anyway.");
    return 1;
  }

  const ctx = {
    bucket: companyBucket(),
    collection: collectionName(),
    uploadPolicy: "summary_metadata_only",
  };

  for (const { adapter, detection } of detected) {
    const target = outputOverride ?? detection.hooksFile;
    const current = await readJsonIfExists(target);
    // 변환은 전적으로 어댑터 몫이다. 여기에 하네스별 분기가 생기면 인터페이스가
    // 부족한 것이고, 그 분기는 하네스가 늘 때마다 번진다.
    const next = adapter.applyHooks(current, ctx);

    if (dryRun) {
      console.log(`[schift-ai-memory] (dry-run) ${adapter.displayName} -> ${target}`);
      console.log(`[schift-ai-memory]   events: ${adapter.events.map((e) => e.event).join(", ")}`);
      continue;
    }

    await atomicWriteJson(target, next);
    console.log(
      `[schift-ai-memory] ${adapter.displayName}: installed ${adapter.events.length} hooks into ${target} (${
        outputOverride ? "--output override" : detection.evidence
      })`,
    );
  }

  if (!dryRun) {
    await writeSetupScope(scope);
    console.log("[schift-ai-memory] existing non-Schift hooks were preserved.");
    console.log("[schift-ai-memory] verify with: npx @schift-io/ai-memory doctor");
  }
  return 0;
}

async function uninstallHarnessHooks(): Promise<number> {
  registerDefaultHarnesses();
  const scope = await resolveScope();
  const detected = detectHarnesses(scope, process.cwd(), homedir());
  for (const { adapter, detection } of detected) {
    const current = await readJsonIfExists(detection.hooksFile);
    const before = adapter.readInstalledEvents(current);
    if (before.length === 0) continue;
    await atomicWriteJson(detection.hooksFile, adapter.removeHooks(current));
    console.log(
      `[schift-ai-memory] ${adapter.displayName}: removed ${before.length} hooks from ${detection.hooksFile}`,
    );
  }
  console.log("[schift-ai-memory] only Schift-owned hooks were removed.");
  return 0;
}

function initPlan() {
  const bucket = companyBucket();
  const collection = collectionName();
  return {
    product: "Schift AI Memory",
    company_bucket: bucket,
    collection,
    upload_policy: "summary_metadata_only",
    role_package: {
      id: "schift.coding-agent.default",
      persona: "coding-agent",
      description: "Default role package for CodingAgent memory upload and retrieval.",
      security: {
        credential_source: "~/.schift/ai-memory/config.json",
        server_authoritative: true,
        client_metadata: "provenance_only",
        required_scopes: [
          "ai_memory:read",
          "ai_memory:write",
          "buckets:read",
          "buckets:upload",
        ],
        default_bucket: bucket,
        default_collection: collection,
      },
      tools: {
        mcp: [
          "search",
          "fetch",
          "schift_search",
          "schift_memory_search",
          "schift_list_buckets",
          "schift_list_bucket_collections",
        ],
        hooks: ["codex-session-start", "codex-stop", "claude-stop", "claude-session-end"],
        disabled_by_default: [
          "schift_workflow_list",
          "schift_workflow_dry_run",
          "schift_workflow_run",
        ],
      },
    },
    install: {
      codex: codexMarketplaceCommand(),
      claude_code_settings_example: claudeCodeSettings(bucket),
      claude_desktop_mcpb: "Download schift-ai-memory.mcpb from GitHub Releases.",
      cursor_mcp: {
        mcpServers: {
          schift: {
            command: "npx",
            args: ["-y", "@schift-io/ai-memory-mcp"],
            env: {
              SCHIFT_DEFAULT_BUCKET: bucket,
              SCHIFT_COLLECTION: collection,
            },
          },
        },
      },
    },
  };
}

function printInit() {
  console.log(JSON.stringify(initPlan(), null, 2));
}

async function init() {
  const plan = initPlan();
  console.log("[schift-ai-memory] initializing AI Memory");
  console.log(`[schift-ai-memory] route bucket=${plan.company_bucket} collection=${plan.collection}`);
  console.log("[schift-ai-memory] policy summary_metadata_only; raw transcript capture is off by default");

  if (hasFlag("--no-login")) {
    console.log("[schift-ai-memory] skipped OAuth login because --no-login was set");
  } else {
    await login();
  }

  await installHarnessHooks();

  console.log("[schift-ai-memory] Codex plugin command:");
  console.log(codexMarketplaceCommand());
  console.log("[schift-ai-memory] MCP server command:");
  console.log("npx -y @schift-io/ai-memory-mcp");
  console.log("[schift-ai-memory] Cursor MCP config is available with:");
  console.log("npx -y @schift-io/ai-memory init --print");
  console.log("[schift-ai-memory] done");
}

function metadataExample() {
  console.log(JSON.stringify(createAiMemoryEvent({
    source: "codex",
    harness: "codex-plugin",
    company_bucket: companyBucket(),
    collection: collectionName(),
    session_id: "local-session-id",
    job: {
      type: "coding",
      title: "Implement AI memory collector",
      intent: "Capture user AI work as company memory",
      status: "completed",
      repo: "schift-io/schift-ai-memory",
      branch: "main",
    },
    summary: "Short user-approved summary of the work.",
  }), null, 2));
}

function openBrowser(url: string) {
  if (hasFlag("--no-open")) {
    console.log(url);
    return;
  }
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}

function createCodeVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function codeChallengeForVerifier(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
        return;
      }
      server.close();
      reject(new Error("Could not find a free loopback port."));
    });
    server.on("error", reject);
  });
}

function readRequestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://127.0.0.1");
}

function respond(res: ServerResponse, status: number, body: string) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function waitForOAuthCode(port: number, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = readRequestUrl(req);
      if (url.pathname !== "/callback") {
        respond(res, 404, "Not found");
        return;
      }
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (state !== expectedState || !code) {
        respond(res, 400, "Schift AI Memory login failed. You can close this window.");
        reject(new Error("OAuth callback state/code mismatch"));
        server.close();
        return;
      }
      respond(res, 200, "Schift AI Memory is connected. You can close this window.");
      resolve(code);
      server.close();
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1");
  });
}

async function exchangeCodeForKey(code: string, codeVerifier: string) {
  const response = await fetch(`${apiBaseUrl().replace(/\/+$/, "")}/v1/auth/cli/code-exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      role_package_id: CODING_AGENT_ROLE_PACKAGE_ID,
    }),
  });
  if (!response.ok) {
    throw new Error(`CLI code exchange failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as {
    key?: string;
    key_preview?: string;
    api_key?: string;
    access_token?: string;
    credential?: { api_key?: string; org_id?: string; user_id?: string };
    defaults?: {
      bucket?: string;
      bucket_id?: string | null;
      collection?: string;
      collection_id?: string | null;
      role_package_id?: string;
    };
    org?: { id?: string };
    user?: Record<string, unknown>;
    security?: Record<string, unknown>;
  };
}

async function fetchMe(apiKey: string) {
  const response = await fetch(`${apiBaseUrl().replace(/\/+$/, "")}/v1/auth/me`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Schift-Client": "ai-memory-cli",
    },
  });
  if (!response.ok) {
    throw new Error(`/v1/auth/me failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

async function verifyApiKey(apiKey: string) {
  const response = await fetch(`${apiBaseUrl().replace(/\/+$/, "")}/v1/buckets`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Schift-Client": "ai-memory-cli",
    },
  });
  if (!response.ok) {
    throw new Error(`API key verification failed: ${response.status} ${await response.text()}`);
  }
  return {
    status: "ok",
    endpoint: "/v1/buckets",
    checked_at: new Date().toISOString(),
  };
}

async function listBuckets(apiKey: string, baseUrl: string) {
  const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/v1/buckets`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Schift-Client": "ai-memory-cli",
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`bucket list failed: ${response.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as Array<{ id?: unknown; name?: unknown }>;
}

async function listCollections(apiKey: string, baseUrl: string, bucketId: string) {
  const response = await fetch(
    `${baseUrl.replace(/\/+$/, "")}/v1/buckets/${encodeURIComponent(bucketId)}/collections`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Schift-Client": "ai-memory-cli",
      },
    },
  );
  if (response.status === 404) return [];
  const text = await response.text();
  if (!response.ok) throw new Error(`collection list failed: ${response.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as Array<{ id?: unknown; name?: unknown }>;
}

async function searchBucket(apiKey: string, baseUrl: string, bucketId: string, query: string) {
  const response = await fetch(
    `${baseUrl.replace(/\/+$/, "")}/v2/buckets/${encodeURIComponent(bucketId)}/search`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "X-Schift-Client": "ai-memory-cli",
      },
      body: JSON.stringify({ query, top_k: 1 }),
    },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`bucket search failed: ${response.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function doctor() {
  const startedAt = new Date().toISOString();
  const checks: Array<Record<string, unknown>> = [];
  let config: Record<string, unknown>;
  try {
    config = await readLocalConfig();
    checks.push({ name: "config", status: "ok", path: configPath() });
  } catch (error) {
    console.log(JSON.stringify({
      status: "needs_login",
      started_at: startedAt,
      checks: [{ name: "config", status: "failed", path: configPath(), error: String(error).slice(0, 200) }],
      next_action: "Run `npx -y @schift-io/ai-memory login`.",
    }, null, 2));
    return;
  }

  // 훅이 실제로 설치돼 있는지 본다 — **감지된 모든 하네스에 대해**.
  // 로그인만 돼 있고 훅이 없으면 아무 것도 수집되지 않는데, 그 상태가
  // "설치했다"로 착각되기 가장 쉽다. 우리 제품 지표가 "설치 커버리지"라
  // 이 구분이 곧 숫자의 정확도다.
  registerDefaultHarnesses();
  const harnessScope = await resolveScope();
  const detectedHarnesses = detectHarnesses(harnessScope, process.cwd(), homedir());
  if (detectedHarnesses.length === 0) {
    checks.push({
      name: "harness",
      status: "none_detected",
      looked_for: listHarnesses().map((a) => a.id),
      next_action: "Install Claude Code or Codex, then run `npx -y @schift-io/ai-memory install`.",
    });
  }
  for (const { adapter, detection } of detectedHarnesses) {
    const cfg = await readJsonIfExists(detection.hooksFile);
    const events = adapter.readInstalledEvents(cfg);
    checks.push(
      events.length > 0
        ? {
            name: `hooks:${adapter.id}`,
            status: "ok",
            path: detection.hooksFile,
            events,
          }
        : {
            name: `hooks:${adapter.id}`,
            status: "missing",
            path: detection.hooksFile,
            next_action: `Run \`npx -y @schift-io/ai-memory install --harness ${adapter.id}\`.`,
          },
    );
  }

  const apiKey = stringValue(config.api_key);
  const baseUrl = stringValue(config.api_base_url) ?? apiBaseUrl();
  const bucketName = stringValue(config.bucket) ?? companyBucket();
  const collection = stringValue(config.collection) ?? collectionName();
  if (collection === "_daily_log") {
    checks.push({
      name: "collection_namespace",
      status: "legacy",
      collection,
      recommended_collection: collectionName(),
      next_action: "Run `npx -y @schift-io/ai-memory login` to move new installs to the reserved __schift_ namespace.",
    });
  }
  if (!apiKey) {
    checks.push({ name: "api_key", status: "failed", error: "missing api_key in local config" });
    console.log(JSON.stringify({
      status: "needs_login",
      started_at: startedAt,
      config: {
        path: configPath(),
        bucket: bucketName,
        collection,
        identity: configIdentity(config),
        local_status: stringValue(config.status) ?? null,
      },
      checks,
      next_action: "Run `npx -y @schift-io/ai-memory login`.",
    }, null, 2));
    return;
  }
  checks.push({ name: "api_key", status: "ok", key_preview: stringValue(config.key_preview) ?? `${apiKey.slice(0, 6)}...` });

  let bucketId = bucketName;
  try {
    const buckets = await listBuckets(apiKey, baseUrl);
    const bucket = buckets.find((entry) => entry.name === bucketName || entry.id === bucketName);
    bucketId = typeof bucket?.id === "string" ? bucket.id : bucketName;
    checks.push({ name: "bucket_access", status: "ok", bucket: bucketName, bucket_id: bucketId });
  } catch (error) {
    checks.push({ name: "bucket_access", status: "failed", error: String(error).slice(0, 240) });
  }

  try {
    const collections = await listCollections(apiKey, baseUrl, bucketId);
    const found = collections.find((entry) => entry.name === collection || entry.id === collection);
    checks.push({
      name: "collection",
      status: found ? "ok" : "metadata_only",
      collection,
      collection_id: typeof found?.id === "string" ? found.id : null,
    });
  } catch (error) {
    checks.push({ name: "collection", status: "failed", collection, error: String(error).slice(0, 240) });
  }

  if (hasFlag("--search")) {
    try {
      const query = argValue("--query") ?? "Schift AI Memory";
      const result = await searchBucket(apiKey, baseUrl, bucketId, query);
      checks.push({
        name: "mcp_search_equivalent",
        status: "ok",
        query,
        result_ready: result.status ?? result.operational_status ?? null,
      });
    } catch (error) {
      checks.push({ name: "mcp_search_equivalent", status: "failed", error: String(error).slice(0, 240) });
    }
  }

  const failed = checks.some((check) => check.status === "failed");
  console.log(JSON.stringify({
    status: failed ? "degraded" : "ok",
    started_at: startedAt,
    config: {
      path: configPath(),
      api_base_url: baseUrl,
      bucket: bucketName,
      collection,
      identity: configIdentity(config),
      security: config.security ?? null,
      local_status: stringValue(config.status) ?? null,
      refresh_after: stringValue(config.refresh_after) ?? null,
      last_upload_error: config.last_upload_error ?? null,
    },
    checks,
    role_package: initPlan().role_package,
  }, null, 2));
}

async function fetchOptionalMe() {
  const authToken = process.env.SCHIFT_AUTH_TOKEN;
  if (!authToken) {
    return {
      status: "skipped",
      reason: "SCHIFT_AUTH_TOKEN not set; code exchange returns a Schift API key, not a user JWT.",
    };
  }
  return {
    status: "ok",
    response: await fetchMe(authToken),
  };
}

async function login() {
  const port = argValue("--port")
    ? Number.parseInt(argValue("--port") ?? "", 10)
    : await findFreePort();
  const state = randomBytes(16).toString("hex");
  const codeVerifier = createCodeVerifier();
  const codeChallenge = codeChallengeForVerifier(codeVerifier);
  const authorizeUrl = new URL("/auth/cli", appBaseUrl());
  authorizeUrl.searchParams.set("port", String(port));
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("bucket", companyBucket());
  authorizeUrl.searchParams.set("collection", collectionName());

  const codePromise = waitForOAuthCode(port, state);
  openBrowser(authorizeUrl.toString());
  console.log("[schift-ai-memory] waiting for browser login...");
  const code = await codePromise;
  const token = await exchangeCodeForKey(code, codeVerifier);
  const apiKey = token.credential?.api_key ?? token.api_key ?? token.key ?? token.access_token;
  if (!apiKey) throw new Error("OAuth response did not include an API key.");
  const api_key_verification = await verifyApiKey(apiKey);
  const me = await fetchOptionalMe();
  const now = new Date();
  const orgId = token.credential?.org_id ?? token.org?.id ?? null;
  const userId = token.credential?.user_id ?? null;
  const defaults = token.defaults && typeof token.defaults === "object" ? token.defaults : {};
  const bucket = typeof defaults.bucket === "string" && defaults.bucket ? defaults.bucket : companyBucket();
  const bucketId = typeof defaults.bucket_id === "string" && defaults.bucket_id ? defaults.bucket_id : null;
  const collection = typeof defaults.collection === "string" && defaults.collection ? defaults.collection : collectionName();
  const collectionId = typeof defaults.collection_id === "string" && defaults.collection_id ? defaults.collection_id : null;
  const rolePackageId = typeof defaults.role_package_id === "string" && defaults.role_package_id
    ? defaults.role_package_id
    : CODING_AGENT_ROLE_PACKAGE_ID;
  await atomicWriteJson(configPath(), {
    api_base_url: apiBaseUrl(),
    app_base_url: appBaseUrl(),
    api_key: apiKey,
    key_preview: token.key_preview ?? null,
    bucket,
    bucket_id: bucketId,
    collection,
    collection_id: collectionId,
    role_package_id: rolePackageId,
    identity: {
      org_id: orgId,
      user_id: userId,
    },
    org_id: orgId,
    user_id: userId,
    api_key_verification,
    me,
    security: token.security ?? null,
    status: "connected",
    verified_at: now.toISOString(),
    refresh_after: addHours(now, 24),
    created_at: now.toISOString(),
  });
  console.log(`[schift-ai-memory] connected ${configPath()}`);
  console.log(JSON.stringify({
    bucket,
    collection,
    collection_id: collectionId,
    identity: {
      org_id: orgId,
      user_id: userId,
    },
    api_key_verification,
    me,
    security: token.security ?? null,
    refresh_after: addHours(now, 24),
  }, null, 2));
}

async function me() {
  const apiKey = process.env.SCHIFT_API_KEY;
  if (!apiKey) {
    throw new Error("SCHIFT_API_KEY is required for `me` unless config loading is added.");
  }
  console.log(JSON.stringify(await fetchMe(apiKey), null, 2));
}

async function main() {
  const command = process.argv[2] ?? "help";
  if (command === "help" || hasFlag("--help") || hasFlag("-h")) {
    printHelp();
    return;
  }
  if (command === "init") {
    if (hasFlag("--print")) {
      printInit();
      return;
    }
    await init();
    return;
  }
  if (command === "login") {
    await login();
    return;
  }
  if (command === "doctor" || command === "status") {
    await doctor();
    return;
  }
  if (command === "me") {
    await me();
    return;
  }
  if (command === "codex-marketplace") {
    console.log(codexMarketplaceCommand());
    return;
  }
  if (command === "uninstall") {
    process.exitCode = await uninstallHarnessHooks();
    return;
  }
  if (command === "install" || command === "hooks") {
    process.exitCode = await installHarnessHooks();
    return;
  }
  if (command === "claude-code-settings") {
    // 하위호환 별칭. 설치 구현은 하나뿐이다 — 두 벌을 유지하면 한쪽만 고쳐지고
    // 그 차이가 "깔았는데 안 도는" 상태로 나타난다.
    console.log("[schift-ai-memory] note: `claude-code-settings` is now an alias for `install`.");
    process.exitCode = await installHarnessHooks();
    return;
  }
  if (command === "metadata-example") {
    metadataExample();
    return;
  }

  console.error(`[schift-ai-memory] unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
