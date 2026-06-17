#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
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

function apiBaseUrl(): string {
  return process.env.SCHIFT_API_BASE_URL ?? "https://api.schift.io";
}

function appBaseUrl(): string {
  return process.env.SCHIFT_APP_BASE_URL ?? "https://schift.io";
}

function configPath(): string {
  return process.env.SCHIFT_AI_MEMORY_CONFIG ?? join(homedir(), ".schift", "ai-memory", "config.json");
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
  return {
    product: "Schift AI Memory",
    company_bucket: bucket,
    collection: collectionName(),
    upload_policy: "summary_metadata_only",
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
              SCHIFT_API_KEY: "sk-...",
              SCHIFT_DEFAULT_BUCKET: bucket,
              SCHIFT_COLLECTION: collectionName(),
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

async function exchangeCodeForKey(code: string, redirectUri: string) {
  const response = await fetch(`${apiBaseUrl().replace(/\/+$/, "")}/v1/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      client_id: "schift-ai-memory-cli",
      code,
      redirect_uri: redirectUri,
      audience: "ai-memory",
      bucket: companyBucket(),
      collection: collectionName(),
    }),
  });
  if (!response.ok) {
    throw new Error(`OAuth exchange failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as {
    api_key?: string;
    access_token?: string;
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

async function login() {
  const port = Number.parseInt(argValue("--port") ?? "17945", 10);
  const state = randomBytes(16).toString("base64url");
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  const authorizeUrl = new URL("/oauth/authorize", appBaseUrl());
  authorizeUrl.searchParams.set("client_id", "schift-ai-memory-cli");
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("scope", "ai_memory:read ai_memory:write");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("bucket", companyBucket());
  authorizeUrl.searchParams.set("collection", collectionName());

  const codePromise = waitForOAuthCode(port, state);
  openBrowser(authorizeUrl.toString());
  console.log("[schift-ai-memory] waiting for browser login...");
  const code = await codePromise;
  const token = await exchangeCodeForKey(code, redirectUri);
  const apiKey = token.api_key ?? token.access_token;
  if (!apiKey) throw new Error("OAuth response did not include an API key.");
  const me = await fetchMe(apiKey);
  await atomicWriteJson(configPath(), {
    api_base_url: apiBaseUrl(),
    app_base_url: appBaseUrl(),
    api_key: apiKey,
    bucket: companyBucket(),
    collection: collectionName(),
    me,
    security: token.security ?? null,
    created_at: new Date().toISOString(),
  });
  console.log(`[schift-ai-memory] connected ${configPath()}`);
  console.log(JSON.stringify({
    bucket: companyBucket(),
    collection: collectionName(),
    me,
    security: token.security ?? null,
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
