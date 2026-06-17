#!/usr/bin/env node
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AiMemorySource,
  createAiMemoryEvent,
  enqueueEvent,
  uploadEvent,
} from "@schift-io/ai-memory-core";

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

async function main() {
  const command = process.argv[2] ?? "codex-stop";
  const payload = parseJson(await readStdin());
  const source = sourceForCommand(command);
  const sessionId = stringValue(payload.session_id) ?? stringValue(payload.sessionId);
  const cwd = stringValue(payload.cwd) ?? stringValue(payload.working_directory);
  const prompt = stringValue(payload.prompt) ?? stringValue(payload.user_prompt);
  const summary = stringValue(payload.summary) ?? stringValue(payload.transcript_summary);

  const event = createAiMemoryEvent({
    source,
    harness: command.startsWith("claude") ? "claude-code-hooks" : "codex-plugin-hooks",
    event_kind: command.includes("session") ? "session_ended" : "ai_job_summary",
    company_bucket: process.env.SCHIFT_COMPANY_BUCKET,
    collection: process.env.SCHIFT_COLLECTION ?? "_daily_log",
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
    },
  });

  const apiKey = process.env.SCHIFT_API_KEY;
  const apiBaseUrl = process.env.SCHIFT_API_BASE_URL ?? "https://api.schift.io";
  if (apiKey && process.env.SCHIFT_AI_MEMORY_UPLOAD === "1") {
    const result = await uploadEvent({ apiBaseUrl, apiKey, event });
    if (result.ok) {
      console.error(`[schift-ai-memory-hooks] uploaded ${result.id}`);
      return;
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
