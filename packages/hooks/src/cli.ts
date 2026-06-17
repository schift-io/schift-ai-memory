#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AiMemorySource,
  atomicWriteJson,
  createAiMemoryEvent,
  enqueueEvent,
  uploadEvent,
} from "@schift-io/ai-memory-core";

interface LocalConfig {
  api_base_url?: string;
  api_key?: string;
  bucket?: string;
  bucket_id?: string;
  collection?: string;
  collection_id?: string;
  role_package_id?: string;
  identity?: {
    org_id?: string | null;
    user_id?: string | null;
  };
  org_id?: string | null;
  user_id?: string | null;
  security?: unknown;
  verified_at?: string;
  refresh_after?: string;
  status?: string;
  last_upload_error?: {
    status: number;
    error?: string;
    checked_at: string;
  };
  [key: string]: unknown;
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function parseJson(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { raw };
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function sourceForCommand(command: string): AiMemorySource {
  return command.startsWith("claude") ? "claude-code" : "codex";
}

function queueDir(): string {
  return process.env.SCHIFT_AI_MEMORY_QUEUE_DIR ?? join(homedir(), ".schift", "ai-memory", "queue");
}

function configPath(): string {
  return process.env.SCHIFT_AI_MEMORY_CONFIG ?? join(homedir(), ".schift", "ai-memory", "config.json");
}

async function readLocalConfig(): Promise<LocalConfig> {
  try {
    return JSON.parse(await readFile(configPath(), "utf8")) as LocalConfig;
  } catch {
    return {};
  }
}

function identityOrgId(config: LocalConfig): string | undefined {
  return stringValue(config.identity?.org_id) ?? stringValue(config.org_id);
}

function identityUserId(config: LocalConfig): string | undefined {
  return stringValue(config.identity?.user_id) ?? stringValue(config.user_id);
}

function refreshDue(config: LocalConfig): boolean {
  if (!config.refresh_after) return false;
  const timestamp = Date.parse(config.refresh_after);
  return Number.isFinite(timestamp) && timestamp <= Date.now();
}

async function markConfigAuthInvalid(config: LocalConfig, status: number, error?: string): Promise<void> {
  if (!config.api_key) return;
  await atomicWriteJson(configPath(), {
    ...config,
    status: "revoked_or_invalid",
    last_upload_error: {
      status,
      error,
      checked_at: new Date().toISOString(),
    },
  });
}

async function main() {
  const command = process.argv[2] ?? "codex-stop";
  const payload = parseJson(await readStdin());
  const config = await readLocalConfig();
  const source = sourceForCommand(command);
  const sessionId = stringValue(payload.session_id) ?? stringValue(payload.sessionId);
  const cwd = stringValue(payload.cwd) ?? stringValue(payload.working_directory);
  const prompt = stringValue(payload.prompt) ?? stringValue(payload.user_prompt);
  const summary = stringValue(payload.summary) ?? stringValue(payload.transcript_summary);
  const bucket =
    process.env.SCHIFT_COMPANY_BUCKET ??
    stringValue(payload.company_bucket) ??
    stringValue(payload.bucket) ??
    stringValue(config.bucket) ??
    "default";
  const collection =
    process.env.SCHIFT_COLLECTION ??
    stringValue(payload.collection) ??
    stringValue(config.collection) ??
    "__schift_ai_daily_log";
  const orgId =
    process.env.SCHIFT_ORG_ID ??
    stringValue(payload.org_id) ??
    stringValue(payload.orgId) ??
    identityOrgId(config);
  const userId =
    process.env.SCHIFT_USER_ID ??
    stringValue(payload.user_id) ??
    stringValue(payload.userId) ??
    identityUserId(config);

  const event = createAiMemoryEvent({
    source,
    harness: command.startsWith("claude") ? "claude-code-hooks" : "codex-plugin-hooks",
    event_kind: command.includes("session") ? "session_ended" : "ai_job_summary",
    org_id: orgId,
    user_id: userId,
    company_bucket: bucket,
    collection,
    session_id: sessionId,
    job: {
      type: process.env.SCHIFT_AI_MEMORY_JOB_TYPE ?? "coding",
      title: prompt?.slice(0, 120) ?? `${source} session ${command}`,
      intent: prompt,
      status: command.includes("fail") ? "failed" : "completed",
      cwd,
      repo: stringValue(payload.repo),
      branch: stringValue(payload.branch),
      commit: stringValue(payload.commit),
    },
    summary,
    metadata: {
      hook_command: command,
      payload_keys: Object.keys(payload).sort(),
      config_metadata: {
        has_api_key: Boolean(config.api_key),
        has_org_id: Boolean(orgId),
        has_user_id: Boolean(userId),
        config_status: stringValue(config.status) ?? "unknown",
        refresh_due: refreshDue(config),
      },
      cached_security: config.security ?? null,
      security_verified_at: config.verified_at,
      security_refresh_after: config.refresh_after,
    },
  });

  const apiKey = process.env.SCHIFT_API_KEY ?? stringValue(config.api_key);
  const apiBaseUrl = process.env.SCHIFT_API_BASE_URL ?? stringValue(config.api_base_url) ?? "https://api.schift.io";
  if (apiKey && process.env.SCHIFT_AI_MEMORY_UPLOAD !== "0") {
    const result = await uploadEvent({ apiBaseUrl, apiKey, event, collectionId: stringValue(config.collection_id) });
    if (result.ok) {
      console.error(`[schift-ai-memory-hooks] uploaded ${result.id}`);
      return;
    }
    if (result.status === 401 || result.status === 403) {
      await markConfigAuthInvalid(config, result.status, result.error);
    }
    console.error(`[schift-ai-memory-hooks] upload failed: ${result.status} ${result.error ?? ""}`);
  }

  const filePath = await enqueueEvent(queueDir(), event);
  console.error(`[schift-ai-memory-hooks] queued ${filePath}`);
}

main().catch(async (error) => {
  try {
    const event = createAiMemoryEvent({
      source: "other",
      harness: "hook-error",
      event_kind: "hook_error",
      job: {
        type: "ops",
        title: "AI memory hook error",
        status: "failed",
      },
      summary: String(error).slice(0, 500),
    });
    await enqueueEvent(queueDir(), event);
  } catch {
    // Hooks must never break the host harness.
  }
  console.error(`[schift-ai-memory-hooks] ${String(error).slice(0, 200)}`);
  process.exit(0);
});
