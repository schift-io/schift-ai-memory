import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";

export type AiMemorySource =
  | "codex"
  | "claude-code"
  | "claude-desktop"
  | "cursor"
  | "chatgpt"
  | "other";

export type AiMemoryEventKind =
  | "ai_job_summary"
  | "session_started"
  | "session_ended"
  | "artifact_pointer"
  | "hook_error";

export type AiJobStatus =
  | "started"
  | "completed"
  | "failed"
  | "cancelled"
  | "unknown";

export interface AiMemoryJobMetadata {
  type: string;
  title: string;
  intent?: string;
  status: AiJobStatus;
  cwd?: string;
  repo?: string;
  branch?: string;
  commit?: string;
}

export interface AiMemoryContentPolicy {
  raw_transcript: boolean;
  artifacts: "none" | "selected" | "all";
  redaction: "default" | "strict" | "off";
}

export interface AiMemoryEvent {
  id: string;
  created_at: string;
  source: AiMemorySource;
  source_version?: string;
  harness: string;
  event_kind: AiMemoryEventKind;
  org_id?: string;
  user_id?: string;
  company_bucket?: string;
  collection?: string;
  session_id?: string;
  job: AiMemoryJobMetadata;
  summary?: string;
  metadata?: Record<string, unknown>;
  content_policy: AiMemoryContentPolicy;
  tags: string[];
}

export interface CreateAiMemoryEventInput {
  source: AiMemorySource;
  source_version?: string;
  harness: string;
  event_kind?: AiMemoryEventKind;
  org_id?: string;
  user_id?: string;
  company_bucket?: string;
  collection?: string;
  session_id?: string;
  job: AiMemoryJobMetadata;
  summary?: string;
  metadata?: Record<string, unknown>;
  content_policy?: Partial<AiMemoryContentPolicy>;
  tags?: string[];
}

export interface UploadResult {
  ok: boolean;
  status: number;
  id?: string;
  error?: string;
}

const DEFAULT_CONTENT_POLICY: AiMemoryContentPolicy = {
  raw_transcript: false,
  artifacts: "selected",
  redaction: "default",
};

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_OPENAI_KEY]"],
  [/\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi, "Bearer [REDACTED_TOKEN]"],
  [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, "[REDACTED_EMAIL]"],
];

export function createAiMemoryEvent(input: CreateAiMemoryEventInput): AiMemoryEvent {
  return {
    id: randomUUID(),
    created_at: new Date().toISOString(),
    ...input,
    event_kind: "ai_job_summary",
    content_policy: {
      ...DEFAULT_CONTENT_POLICY,
      ...input.content_policy,
    },
    tags: input.tags ?? [`source:${input.source}`, `job:${input.job.type}`],
  };
}

export function redactText(text: string, mode: AiMemoryContentPolicy["redaction"] = "default"): string {
  if (mode === "off") return text;
  let redacted = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  if (mode === "strict") {
    redacted = redacted.replace(/\/Users\/[^/\s]+/g, "/Users/[REDACTED_USER]");
    redacted = redacted.replace(/\/home\/[^/\s]+/g, "/home/[REDACTED_USER]");
  }
  return redacted;
}

export function redactEvent(event: AiMemoryEvent): AiMemoryEvent {
  const redaction = event.content_policy.redaction;
  return {
    ...event,
    summary: event.summary ? redactText(event.summary, redaction) : undefined,
    job: {
      ...event.job,
      title: redactText(event.job.title, redaction),
      intent: event.job.intent ? redactText(event.job.intent, redaction) : undefined,
      cwd: event.job.cwd ? redactText(event.job.cwd, redaction) : undefined,
    },
  };
}

export async function enqueueEvent(queueDir: string, event: AiMemoryEvent): Promise<string> {
  await mkdir(queueDir, { recursive: true });
  const filePath = join(queueDir, `${event.created_at.replace(/[:.]/g, "-")}-${event.id}.json`);
  await writeFile(filePath, `${JSON.stringify(redactEvent(event), null, 2)}\n`, "utf8");
  return filePath;
}

export async function uploadEvent(options: {
  apiBaseUrl: string;
  apiKey: string;
  event: AiMemoryEvent;
  endpoint?: string;
}): Promise<UploadResult> {
  const baseUrl = options.apiBaseUrl.replace(/\/+$/, "");
  const endpoint = options.endpoint ?? "/v1/ai-memory/events";
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${endpoint}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        "X-Schift-Client": "ai-memory",
      },
      body: JSON.stringify(redactEvent(options.event)),
    });
  } catch (error) {
    return { ok: false, status: 0, error: String(error).slice(0, 200) };
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return { ok: false, status: response.status, error: detail.slice(0, 300) };
  }

  const body = (await response.json().catch(() => ({}))) as { id?: unknown };
  return {
    ok: true,
    status: response.status,
    id: typeof body.id === "string" ? body.id : options.event.id,
  };
}

export async function readJsonFile<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

export async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmpPath, filePath);
}
