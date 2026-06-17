#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { atomicWriteJson, createAiMemoryEvent } from "@schift-io/ai-memory-core";

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
  schift-ai-memory login [--bucket default] [--collection _daily_log]
  schift-ai-memory doctor
  schift-ai-memory status
  schift-ai-memory me
  schift-ai-memory codex-marketplace
  schift-ai-memory claude-code-settings [--bucket <company-bucket>]
  schift-ai-memory metadata-example

The default init flow connects OAuth, writes a Claude Code settings example,
and prints the remaining host-specific install commands. Use --print for a
machine-readable install plan.
`);
}

function companyBucket(): string {
  return argValue("--bucket") ?? process.env.SCHIFT_COMPANY_BUCKET ?? "default";
}

function collectionName(): string {
  return argValue("--collection") ?? process.env.SCHIFT_COLLECTION ?? "_daily_log";
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

async function writeClaudeCodeSettings() {
  const output = argValue("--output") ?? join(homedir(), ".claude", "settings.schift-ai-memory.example.json");
  await atomicWriteJson(output, claudeCodeSettings(companyBucket()));
  console.log(`[schift-ai-memory] wrote ${output}`);
  console.log("[schift-ai-memory] review and merge this into ~/.claude/settings.json when ready.");
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

  await writeClaudeCodeSettings();

  console.log("[schift-ai-memory] Codex plugin command:");
  console.log(codexMarketplaceCommand());
  console.log("[schift-ai-memory] MCP server command:");
  console.log("npx -y @schift-io/ai-memory-mcp");
  console.log("[schift-ai-memory] Cursor MCP config is available with:");
  console.log("npx -y schift-ai-memory init --print");
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
      next_action: "Run `npx -y schift-ai-memory login`.",
    }, null, 2));
    return;
  }

  const apiKey = stringValue(config.api_key);
  const baseUrl = stringValue(config.api_base_url) ?? apiBaseUrl();
  const bucketName = stringValue(config.bucket) ?? companyBucket();
  const collection = stringValue(config.collection) ?? collectionName();
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
      next_action: "Run `npx -y schift-ai-memory login`.",
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
  await atomicWriteJson(configPath(), {
    api_base_url: apiBaseUrl(),
    app_base_url: appBaseUrl(),
    api_key: apiKey,
    key_preview: token.key_preview ?? null,
    bucket: companyBucket(),
    collection: collectionName(),
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
    bucket: companyBucket(),
    collection: collectionName(),
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
  if (command === "claude-code-settings") {
    if (hasFlag("--print")) {
      console.log(JSON.stringify(claudeCodeSettings(companyBucket()), null, 2));
      return;
    }
    await writeClaudeCodeSettings();
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
