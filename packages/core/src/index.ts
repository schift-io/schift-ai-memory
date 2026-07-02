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

export interface CclgMemoryPayload {
  schema_version: string;
  session_id?: string;
  node_ids?: string[];
  patch_ids?: string[];
  source_labels?: string[];
  summary?: string;
  [key: string]: unknown;
}

export interface SchiftAiMemoryEnvelopeMetadata {
  org_id?: string;
  user_id?: string;
  bucket: string;
  collection: string;
  upload_policy: "summary_metadata_only";
  redaction: AiMemoryContentPolicy["redaction"];
  [key: string]: unknown;
}

export interface AiMemoryEvent {
  id: string;
  created_at: string;
  schema_version?: string;
  kind?: string;
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
  schift?: SchiftAiMemoryEnvelopeMetadata;
  cclg?: CclgMemoryPayload;
  content_policy: AiMemoryContentPolicy;
  tags: string[];
}

export interface CreateAiMemoryEventInput {
  schema_version?: string;
  kind?: string;
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
  schift?: SchiftAiMemoryEnvelopeMetadata;
  cclg?: CclgMemoryPayload;
  content_policy?: Partial<AiMemoryContentPolicy>;
  tags?: string[];
}

export interface CreateCclgAiMemoryEventInput extends Omit<CreateAiMemoryEventInput, "cclg"> {
  cclg: CclgMemoryPayload;
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

function cclgMetadata(payload: CclgMemoryPayload): Record<string, unknown> {
  return {
    schema_version: payload.schema_version,
    session_id: payload.session_id,
    node_ids: payload.node_ids,
    patch_ids: payload.patch_ids,
    source_labels: payload.source_labels,
  };
}

export function createCclgAiMemoryEvent(input: CreateCclgAiMemoryEventInput): AiMemoryEvent {
  const contentPolicy = {
    ...DEFAULT_CONTENT_POLICY,
    ...input.content_policy,
  };
  return createAiMemoryEvent({
    ...input,
    schema_version: "schift.ai_memory_envelope.v0.1",
    kind: "cclg_session_summary",
    summary: input.summary ?? input.cclg.summary,
    metadata: {
      ...input.metadata,
      cclg: cclgMetadata(input.cclg),
    },
    schift: {
      org_id: input.org_id,
      user_id: input.user_id,
      bucket: input.company_bucket ?? "default",
      collection: input.collection ?? "__schift_ai_daily_log",
      upload_policy: "summary_metadata_only",
      redaction: contentPolicy.redaction,
    },
    tags: input.tags ?? [`source:${input.source}`, `job:${input.job.type}`, "format:cclg"],
  });
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

function redactUnknown(value: unknown, mode: AiMemoryContentPolicy["redaction"]): unknown {
  if (typeof value === "string") return redactText(value, mode);
  if (Array.isArray(value)) return value.map((entry) => redactUnknown(entry, mode));
  if (value && typeof value === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      redacted[key] = redactUnknown(entry, mode);
    }
    return redacted;
  }
  return value;
}

function redactRecord(value: Record<string, unknown>, mode: AiMemoryContentPolicy["redaction"]): Record<string, unknown> {
  return redactUnknown(value, mode) as Record<string, unknown>;
}

function redactCclgPayload(payload: CclgMemoryPayload, mode: AiMemoryContentPolicy["redaction"]): CclgMemoryPayload {
  return {
    ...redactRecord(payload, mode),
    schema_version: redactText(payload.schema_version, mode),
  } as CclgMemoryPayload;
}

export function redactEvent(event: AiMemoryEvent): AiMemoryEvent {
  const redaction = event.content_policy.redaction;
  return {
    ...event,
    summary: event.summary ? redactText(event.summary, redaction) : undefined,
    metadata: event.metadata ? redactRecord(event.metadata, redaction) : undefined,
    schift: event.schift ? (redactRecord(event.schift, redaction) as SchiftAiMemoryEnvelopeMetadata) : undefined,
    cclg: event.cclg ? redactCclgPayload(event.cclg, redaction) : undefined,
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
  collectionId?: string;
  endpoint?: string;
}): Promise<UploadResult> {
  const baseUrl = options.apiBaseUrl.replace(/\/+$/, "");
  const event = redactEvent(options.event);
  const bucketName = event.company_bucket ?? "default";
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/buckets`, {
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "X-Schift-Client": "ai-memory",
      },
    });
  } catch (error) {
    return { ok: false, status: 0, error: String(error).slice(0, 200) };
  }
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return { ok: false, status: response.status, error: detail.slice(0, 300) };
  }

  const buckets = (await response.json().catch(() => [])) as Array<{ id?: unknown; name?: unknown }>;
  const bucket = buckets.find((entry) => entry.name === bucketName || entry.id === bucketName);
  const bucketId = typeof bucket?.id === "string" ? bucket.id : bucketName;
  const collectionName = event.collection ?? "__schift_ai_daily_log";
  let collectionId: string | undefined = options.collectionId;
  if (!collectionId) {
    try {
      const collectionResponse = await fetch(`${baseUrl}/v1/buckets/${encodeURIComponent(bucketId)}/collections`, {
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "X-Schift-Client": "ai-memory",
        },
      });
      if (collectionResponse.ok) {
        const collections = (await collectionResponse.json().catch(() => [])) as Array<{
          id?: unknown;
          name?: unknown;
        }>;
        const collection = collections.find((entry) => entry.name === collectionName || entry.id === collectionName);
        if (typeof collection?.id === "string") collectionId = collection.id;
      }
    } catch {
      collectionId = undefined;
    }
  }
  const filename = `${event.collection ?? "__schift_ai_daily_log"}-${event.created_at.slice(0, 10)}-${event.id}.json`;
  const metadata: Record<string, string> = {
    source: event.source,
    harness: event.harness,
    event_kind: event.event_kind,
    collection: collectionName,
    job_type: event.job.type,
    job_status: event.job.status,
    job_title: event.job.title,
  };
  if (event.org_id) metadata.org_id = event.org_id;
  if (event.user_id) metadata.user_id = event.user_id;
  if (event.session_id) metadata.session_id = event.session_id;
  if (event.job.repo) metadata.repo = event.job.repo;
  if (event.job.branch) metadata.branch = event.job.branch;
  if (event.schema_version) metadata.envelope_schema_version = event.schema_version;
  if (event.kind) metadata.envelope_kind = event.kind;
  if (event.cclg) {
    metadata.memory_format = "cclg";
    metadata.cclg_schema_version = event.cclg.schema_version;
    if (event.cclg.session_id) metadata.cclg_session_id = event.cclg.session_id;
    if (event.cclg.node_ids?.length) metadata.cclg_node_ids = event.cclg.node_ids.join(",");
    if (event.cclg.patch_ids?.length) metadata.cclg_patch_ids = event.cclg.patch_ids.join(",");
    if (event.cclg.source_labels?.length) metadata.cclg_source_labels = event.cclg.source_labels.join(",");
  }

  const form = new FormData();
  form.append("files", new Blob([JSON.stringify(event, null, 2)], { type: "application/json" }), filename);
  form.append("metadata", JSON.stringify(metadata));
  if (collectionId) form.append("collection_id", collectionId);

  try {
    response = await fetch(`${baseUrl}${options.endpoint ?? `/v1/buckets/${encodeURIComponent(bucketId)}/upload`}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "X-Schift-Client": "ai-memory",
      },
      body: form,
    });
  } catch (error) {
    return { ok: false, status: 0, error: String(error).slice(0, 200) };
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return { ok: false, status: response.status, error: detail.slice(0, 300) };
  }

  const body = (await response.json().catch(() => ({}))) as { id?: unknown };
  const jobId =
    Array.isArray((body as { jobs?: unknown }).jobs) &&
    typeof ((body as { jobs: Array<{ job_id?: unknown }> }).jobs[0]?.job_id) === "string"
      ? (body as { jobs: Array<{ job_id: string }> }).jobs[0].job_id
      : undefined;
  return {
    ok: true,
    status: response.status,
    id: typeof body.id === "string" ? body.id : jobId ?? options.event.id,
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
