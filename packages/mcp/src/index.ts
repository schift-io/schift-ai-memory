import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

export interface SchiftMcpConfig {
  apiBaseUrl: string;
  apiKey: string;
  userId?: string;
  defaultBucket?: string;
  memoryBuckets?: string[];
}

export interface MemorySearchHit {
  id: string;
  score: number;
  text: string;
  bucket_id: string;
  source: string;
  metadata: Record<string, unknown>;
}

export interface SchiftSearchHit {
  id: string;
  score: number;
  text: string;
  metadata: Record<string, unknown>;
  neighbors?: unknown[] | null;
  citation?: string | null;
}

interface SchiftSearchCitation {
  index?: number;
  chunk_id?: string;
  document_id?: string;
  source_id?: string;
  title?: string;
  source_url?: string;
  page?: number | string;
  section?: string;
}

interface MemorySearchResponse {
  query: string;
  hits: MemorySearchHit[];
  bucket_count: number;
  sources_searched: string[];
}

interface SourceListEntry {
  id: string;
  source_type: string;
  display_name: string | null;
  status: string;
  docs_indexed: number;
  last_synced_at: string | null;
}

interface BucketListEntry {
  id: string;
  name: string;
  description?: string;
  model?: string;
  backend?: string;
  file_count?: number;
  vector_count?: number;
  active_job_count?: number;
}

interface BucketCollectionEntry {
  id: string;
  bucket_id: string;
  name: string;
  description?: string;
  model?: string;
  backend?: string;
  file_count?: number;
  vector_count?: number;
  active_job_count?: number;
}

interface UploadJobInfo {
  job_id: string;
  document_id: string;
  file_name: string;
  file_type: string;
  status: string;
  estimated_cost: number;
}

interface AsyncUploadResponse {
  jobs: UploadJobInfo[];
  total_estimated_cost: number;
}

interface BucketSearchResponse {
  bucket_id: string;
  query: string;
  search_id?: string | null;
  results?: SchiftSearchHit[];
  context?: string;
  citations?: SchiftSearchCitation[];
  degraded?: boolean;
  warnings?: unknown[];
}

type JsonObject = Record<string, unknown>;

export const MCP_CLIENT_NAME = "mcp";
export const MCP_SERVER_VERSION = "0.2.0";

interface WorkflowV2Summary {
  id: string;
  name: string;
  description?: string;
  status: string;
  block_count: number;
  updated_at: string;
  created_at: string;
  published_at?: string | null;
}

interface WorkflowV2RunResult {
  id: string;
  workflow_id: string;
  org_id: string;
  status: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  block_states: Record<string, unknown>;
  error?: string | null;
  started_at: string;
  finished_at?: string | null;
  created_at: string;
}

interface FetchCacheEntry {
  id: string;
  title: string;
  text: string;
  url: string;
  bucket_id: string;
  metadata: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArg(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberArg(args: JsonObject, key: string): number | undefined {
  const value = args[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArrayArg(args: JsonObject, key: string): string[] | undefined {
  const value = args[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function integerArg(args: JsonObject, key: string): number | undefined {
  const value = numberArg(args, key);
  return value === undefined ? undefined : Math.trunc(value);
}

function parseTagFilters(tags?: string[]): JsonObject {
  const filter: JsonObject = {};
  for (const tag of tags ?? []) {
    const idx = tag.indexOf(":");
    if (idx <= 0 || idx === tag.length - 1) continue;
    filter[tag.slice(0, idx).trim()] = tag.slice(idx + 1).trim();
  }
  return filter;
}

function buildFilter(args: JsonObject): JsonObject | undefined {
  const explicitFilter = isPlainObject(args.filter) ? { ...args.filter } : {};
  const tagFilter = parseTagFilters(stringArrayArg(args, "tags"));
  const sources = stringArrayArg(args, "sources");
  const filter = { ...explicitFilter, ...tagFilter };
  if (sources?.length === 1) filter.source = sources[0];
  if (sources && sources.length > 1) filter.source = sources;
  return Object.keys(filter).length ? filter : undefined;
}

export function bucketFromArgs(args: JsonObject, config: Pick<SchiftMcpConfig, "defaultBucket">): string {
  return stringArg(args, "bucket") ?? stringArg(args, "collection") ?? config.defaultBucket ?? "default";
}

export function bucketSearchBodyFromArgs(args: JsonObject): JsonObject {
  const query = stringArg(args, "query");
  if (!query) throw new Error("search requires a non-empty `query`.");

  const body: JsonObject = {
    query,
    top_k: Math.trunc(numberArg(args, "top_k") ?? numberArg(args, "topK") ?? 10),
  };
  const filter = buildFilter(args);
  if (filter) body.filters = filter;

  const options: JsonObject = {};
  if (args.rerank !== undefined || args.rerank_top_k !== undefined) {
    options.rerank = {
      ...(args.rerank !== undefined ? { enabled: Boolean(args.rerank) } : {}),
      ...(args.rerank_top_k !== undefined ? { top_k: args.rerank_top_k } : {}),
    };
  }
  if (args.task !== undefined) {
    options.instructions = { task: args.task };
  }
  if (Object.keys(options).length) {
    body.options = options;
  }

  return body;
}

export function workflowRunBodyFromArgs(args: JsonObject): { workflowId: string; body: JsonObject } {
  const workflowId = stringArg(args, "workflow_id") ?? stringArg(args, "workflowId");
  if (!workflowId) throw new Error("workflow tools require a non-empty `workflow_id`.");
  const inputs = isPlainObject(args.inputs) ? args.inputs : {};
  const body: JsonObject = { inputs };
  const mode = stringArg(args, "mode");
  if (mode) {
    if (mode !== "simulate" && mode !== "live") {
      throw new Error("workflow run `mode` must be simulate or live.");
    }
    body.mode = mode;
  }
  if (isPlainObject(args.approvals)) {
    body.approvals = args.approvals;
  }
  return { workflowId, body };
}

export function memorySearchBodyFromArgs(args: JsonObject): JsonObject {
  const query = stringArg(args, "query");
  if (!query) throw new Error("search requires a non-empty `query`.");

  const body: JsonObject = {
    query,
    top_k: Math.trunc(numberArg(args, "top_k") ?? numberArg(args, "topK") ?? 20),
  };
  const sources = stringArrayArg(args, "sources");
  const tags = stringArrayArg(args, "tags");
  if (sources?.length) body.sources = sources;
  if (tags?.length) body.tags = tags;

  for (const [argName, apiName] of [
    ["rerank", "rerank"],
    ["temporal", "temporal"],
    ["temporal_start", "temporal_start"],
    ["temporal_end", "temporal_end"],
  ] as const) {
    if (args[argName] !== undefined) body[apiName] = args[argName];
  }

  return body;
}

export function uploadFormFromArgs(args: JsonObject): FormData {
  const filename = stringArg(args, "filename");
  if (!filename) throw new Error("upload requires a non-empty `filename`.");

  const text = stringArg(args, "text") ?? stringArg(args, "content");
  const contentBase64 = stringArg(args, "content_base64") ?? stringArg(args, "contentBase64");
  if (!text && !contentBase64) {
    throw new Error("upload requires `text`/`content` or `content_base64`.");
  }
  if (text && contentBase64) {
    throw new Error("upload accepts either `text`/`content` or `content_base64`, not both.");
  }

  const contentType = stringArg(args, "content_type") ?? stringArg(args, "contentType") ?? "text/plain";
  const bytes = contentBase64
    ? Buffer.from(contentBase64, "base64")
    : Buffer.from(text as string, "utf8");

  const form = new FormData();
  form.append("files", new Blob([bytes], { type: contentType }), filename);

  const ocrStrategy = stringArg(args, "ocr_strategy") ?? stringArg(args, "ocrStrategy");
  if (ocrStrategy) form.append("ocr_strategy", ocrStrategy);
  const chunkSize = integerArg(args, "chunk_size") ?? integerArg(args, "chunkSize");
  if (chunkSize !== undefined) form.append("chunk_size", String(chunkSize));
  const chunkOverlap = integerArg(args, "chunk_overlap") ?? integerArg(args, "chunkOverlap");
  if (chunkOverlap !== undefined) form.append("chunk_overlap", String(chunkOverlap));
  const collectionId = stringArg(args, "collection_id") ?? stringArg(args, "collectionId");
  if (collectionId) form.append("collection_id", collectionId);
  if (isPlainObject(args.metadata)) {
    form.append("metadata", JSON.stringify(args.metadata));
  }
  return form;
}

const TOOLS = [
  {
    name: "search",
    description:
      "ChatGPT-compatible search alias. Searches the configured default bucket, or the user's `default` bucket when no default is configured, and returns result IDs, titles, and URLs.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
  },
  {
    name: "fetch",
    description:
      "ChatGPT-compatible fetch alias. Returns cached content for a result ID previously returned by search.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
      },
      required: ["id"],
    },
  },
  {
    name: "schift_search",
    description:
      "Search a Schift bucket through the v2 knowledge-search API and return answer-ready context with citations.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        bucket: {
          type: "string",
          description: "Bucket id or bucket name. Defaults to SCHIFT_DEFAULT_BUCKET, then `default`.",
        },
        collection: {
          type: "string",
          description: "Deprecated alias for bucket.",
        },
        top_k: { type: "number", default: 10 },
        filter: {
          type: "object",
          description: "Metadata filters passed through to Schift bucket search.",
        },
        task: {
          type: "string",
          description: "Optional search instruction preset such as question_answering.",
        },
        rerank: { type: "boolean" },
        rerank_top_k: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "schift_list_buckets",
    description:
      "List Schift buckets available to the API key. Use this before search when the user did not name a bucket.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "schift_list_bucket_collections",
    description:
      "List child collections inside a Schift bucket, useful for choosing metadata filters or explaining scope.",
    inputSchema: {
      type: "object",
      properties: {
        bucket: { type: "string", description: "Bucket id or bucket name." },
      },
      required: ["bucket"],
    },
  },
  {
    name: "schift_upload_document",
    description:
      "Upload a text or base64-encoded file into a Schift bucket and queue async ingestion. " +
      "Search the same bucket after the returned job finishes.",
    inputSchema: {
      type: "object",
      properties: {
        bucket: {
          type: "string",
          description: "Bucket id or bucket name. Defaults to SCHIFT_DEFAULT_BUCKET, then `default`.",
        },
        filename: { type: "string" },
        text: {
          type: "string",
          description: "UTF-8 text content to upload. Use content_base64 for binary files.",
        },
        content: {
          type: "string",
          description: "Deprecated alias for text.",
        },
        content_base64: {
          type: "string",
          description: "Base64-encoded file content for PDFs, images, docs, or other binary files.",
        },
        content_type: {
          type: "string",
          description: "MIME type, for example text/plain or application/pdf.",
        },
        metadata: {
          type: "object",
          description: "Optional document metadata stored with the upload.",
        },
        collection_id: {
          type: "string",
          description: "Optional child collection id inside the bucket.",
        },
        ocr_strategy: {
          type: "string",
          description: "OCR strategy passed to Schift upload, defaults to auto.",
        },
        chunk_size: { type: "number" },
        chunk_overlap: { type: "number" },
      },
      required: ["filename"],
    },
  },
  {
    name: "schift_memory_search",
    description:
      "Compatibility alias for Schift memory search. Uses the authenticated user's memory layer by default, " +
      "or configured SCHIFT_MEMORY_BUCKETS when provided. Returns ranked passages drawn " +
      "from connected sources (Gmail/Notion/Slack/Linear/GitHub/Calendar/...) " +
      "with citations. Filterable by source list, tag list (key:value), and time.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        bucket: {
          type: "string",
          description:
            "Optional bucket override. Otherwise the authenticated user's memory layer is searched.",
        },
        sources: {
          type: "array",
          items: { type: "string" },
          description: "Filter to these source types (notion, slack, gmail, ...).",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "key:value tag filters AND-combined.",
        },
        top_k: { type: "number", default: 20 },
        temporal: {
          type: "string",
          enum: ["before", "after", "between", "as_of", "latest"],
        },
        temporal_start: { type: "number" },
        temporal_end: { type: "number" },
      },
      required: ["query"],
    },
  },
  {
    name: "schift_memory_list_sources",
    description:
      "List the user's connected memory sources with sync status and " +
      "indexed document count.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "schift_workflow_list",
    description:
      "List the organization's AWP-origin workflows (installed workflow packs). " +
      "Returns id, name, status, and block count. Only `published` workflows are " +
      "runnable; `draft` workflows need a human to review and publish them in the " +
      "Schift console first.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "schift_workflow_dry_run",
    description:
      "Dry-run a stored AWP workflow with the given inputs. Safe to call any time: " +
      "it produces no side effects and returns block-level results so the user can " +
      "review what the workflow would do before running it.",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: { type: "string" },
        inputs: {
          type: "object",
          description: "Workflow input values keyed by input name.",
        },
      },
      required: ["workflow_id"],
    },
  },
  {
    name: "schift_workflow_run",
    description:
      "Run a published AWP workflow and record the run. If the workflow is still a " +
      "draft, this returns status `needs_review` instead of running — a human must " +
      "review and publish the workflow in the Schift console before agents can run " +
      "it. mode `simulate` (default) stages side effects; mode `live` really " +
      "executes them, and every human_approval block halts with " +
      "`waiting_approval` until the user explicitly confirms — pass " +
      "approvals[block_id]=true only after a person approved that step. Prefer " +
      "schift_workflow_dry_run first when the user has not confirmed.",
    inputSchema: {
      type: "object",
      properties: {
        workflow_id: { type: "string" },
        inputs: {
          type: "object",
          description: "Workflow input values keyed by input name.",
        },
        mode: {
          type: "string",
          enum: ["simulate", "live"],
          description: "simulate stages side effects; live really executes them.",
        },
        approvals: {
          type: "object",
          description:
            "Per-block human approvals, e.g. {\"review_issue\": true}. Only set " +
            "after a person explicitly approved that step.",
        },
      },
      required: ["workflow_id"],
    },
  },
] as const;

type ToolName = (typeof TOOLS)[number]["name"];
const WORKFLOW_TOOL_NAMES = new Set<string>([
  "schift_workflow_list",
  "schift_workflow_dry_run",
  "schift_workflow_run",
]);

function visibleTools() {
  if (process.env.SCHIFT_AI_MEMORY_ENABLE_WORKFLOW_TOOLS === "1") {
    return [...TOOLS];
  }
  return TOOLS.filter((tool) => !WORKFLOW_TOOL_NAMES.has(tool.name));
}

export function createServer(config: SchiftMcpConfig) {
  const server = new Server(
    { name: "schift-memory", version: MCP_SERVER_VERSION },
    { capabilities: { tools: {} } },
  );

  const baseUrl = config.apiBaseUrl.replace(/\/+$/, "");
  const bucketIdCache = new Map<string, string>();
  const fetchCache = new Map<string, FetchCacheEntry>();

  async function callApi<T>(
    path: string,
    init: RequestInit = {},
    toolName?: ToolName,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${config.apiKey}`);
    headers.set("X-Schift-Client", MCP_CLIENT_NAME);
    headers.set("X-Schift-MCP-Version", MCP_SERVER_VERSION);
    if (toolName) headers.set("X-Schift-MCP-Tool", toolName);
    if (init.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json");
    }
    const resp = await fetch(`${baseUrl}${path}`, { ...init, headers });
    if (!resp.ok) {
      const detail = await resp.text();
      throw new Error(`schift API ${resp.status}: ${detail.slice(0, 200)}`);
    }
    return (await resp.json()) as T;
  }

  async function listBuckets(toolName?: ToolName): Promise<BucketListEntry[]> {
    return callApi<BucketListEntry[]>("/v1/buckets", {}, toolName);
  }

  async function resolveBucketId(bucket: string, toolName?: ToolName): Promise<string> {
    if (bucketIdCache.has(bucket)) return bucketIdCache.get(bucket) as string;
    if (bucket.startsWith("public--")) return bucket;
    try {
      const buckets = await listBuckets(toolName);
      const found = buckets.find((item) => item.id === bucket || item.name === bucket);
      const resolved = found?.id ?? bucket;
      bucketIdCache.set(bucket, resolved);
      return resolved;
    } catch {
      return bucket;
    }
  }

  async function searchBucket(
    bucket: string,
    args: JsonObject,
    toolName: ToolName,
  ): Promise<BucketSearchResponse> {
    const bucketId = await resolveBucketId(bucket, toolName);
    return callApi<BucketSearchResponse>(
      `/v2/buckets/${encodeURIComponent(bucketId)}/search`,
      {
        method: "POST",
        body: JSON.stringify(bucketSearchBodyFromArgs(args)),
      },
      toolName,
    );
  }

  function titleForHit(hit: SchiftSearchHit): string {
    for (const key of ["title", "name", "source", "document_id", "file_name"]) {
      const value = hit.metadata?.[key];
      if (typeof value === "string" && value.trim()) return value.trim();
    }
    return hit.id;
  }

  function urlForHit(hit: SchiftSearchHit, bucketId: string): string {
    const url = hit.metadata?.url ?? hit.metadata?.source_url;
    if (typeof url === "string" && url.trim()) return url.trim();
    return `schift://bucket/${encodeURIComponent(bucketId)}/chunks/${encodeURIComponent(hit.id)}`;
  }

  function hitsFromBucketSearchResponse(response: BucketSearchResponse): SchiftSearchHit[] {
    if (Array.isArray(response.results)) return response.results;
    const context = typeof response.context === "string" ? response.context : "";
    return (response.citations ?? []).map((citation, index) => ({
      id: citation.chunk_id ?? citation.document_id ?? citation.source_id ?? `citation-${index + 1}`,
      score: 1,
      text: context,
      metadata: {
        ...citation,
        citation_index: citation.index ?? index + 1,
      },
      citation: citation.title ?? citation.source_url ?? null,
    }));
  }

  function rememberHits(response: BucketSearchResponse) {
    for (const hit of hitsFromBucketSearchResponse(response)) {
      const entry: FetchCacheEntry = {
        id: hit.id,
        title: titleForHit(hit),
        text: hit.text,
        url: urlForHit(hit, response.bucket_id),
        bucket_id: response.bucket_id,
        metadata: hit.metadata ?? {},
      };
      fetchCache.set(hit.id, entry);
    }
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: visibleTools() }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs = {} } = req.params;
    const args = isPlainObject(rawArgs) ? rawArgs : {};

    if (
      WORKFLOW_TOOL_NAMES.has(name) &&
      process.env.SCHIFT_AI_MEMORY_ENABLE_WORKFLOW_TOOLS !== "1"
    ) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "disabled",
                message:
                  "Workflow tools are disabled in Schift AI Memory by default. Set SCHIFT_AI_MEMORY_ENABLE_WORKFLOW_TOOLS=1 only when you intentionally want workflow execution tools.",
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === "search") {
      const out = await searchBucket(
        bucketFromArgs(args, config),
        {
          ...args,
          top_k: numberArg(args, "top_k") ?? 10,
        },
        "search",
      );
      rememberHits(out);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                results: hitsFromBucketSearchResponse(out).map((hit) => ({
                  id: hit.id,
                  title: titleForHit(hit),
                  url: urlForHit(hit, out.bucket_id),
                })),
              },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (name === "fetch") {
      const id = stringArg(args, "id");
      if (!id) throw new Error("fetch requires `id`.");
      const entry = fetchCache.get(id);
      if (!entry) {
        throw new Error(
          "fetch result is not cached. Call search first, then fetch one of its returned IDs.",
        );
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(entry, null, 2),
          },
        ],
      };
    }

    if (name === "schift_search") {
      const out = await searchBucket(bucketFromArgs(args, config), args, "schift_search");
      rememberHits(out);
      const normalized = {
        ...out,
        results: hitsFromBucketSearchResponse(out),
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(normalized, null, 2),
          },
        ],
      };
    }

    if (name === "schift_list_buckets") {
      const out = await listBuckets("schift_list_buckets");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(out, null, 2),
          },
        ],
      };
    }

    if (name === "schift_list_bucket_collections") {
      const bucket = stringArg(args, "bucket");
      if (!bucket) throw new Error("schift_list_bucket_collections requires `bucket`.");
      const bucketId = await resolveBucketId(bucket, "schift_list_bucket_collections");
      const out = await callApi<BucketCollectionEntry[]>(
        `/v1/buckets/${encodeURIComponent(bucketId)}/collections`,
        {},
        "schift_list_bucket_collections",
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(out, null, 2),
          },
        ],
      };
    }

    if (name === "schift_upload_document") {
      const bucketId = await resolveBucketId(bucketFromArgs(args, config), "schift_upload_document");
      const out = await callApi<AsyncUploadResponse>(
        `/v2/buckets/${encodeURIComponent(bucketId)}/documents`,
        {
          method: "POST",
          body: uploadFormFromArgs(args),
        },
        "schift_upload_document",
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(out, null, 2),
          },
        ],
      };
    }

    if (name === "schift_memory_search") {
      const bucketOverride = stringArg(args, "bucket");
      const buckets = bucketOverride
        ? [bucketOverride]
        : (config.memoryBuckets?.length ? config.memoryBuckets : undefined);
      if (!buckets) {
        const out = await callApi<MemorySearchResponse>(
          "/v1/memory/search",
          {
            method: "POST",
            body: JSON.stringify(memorySearchBodyFromArgs(args)),
          },
          "schift_memory_search",
        );
        for (const hit of out.hits) {
          fetchCache.set(hit.id, {
            id: hit.id,
            title: titleForHit(hit),
            text: hit.text,
            url: urlForHit(hit, hit.bucket_id),
            bucket_id: hit.bucket_id,
            metadata: hit.metadata ?? {},
          });
        }
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(out, null, 2),
            },
          ],
        };
      }
      const responses = await Promise.allSettled(
        buckets.map((bucket) => searchBucket(bucket, args, "schift_memory_search")),
      );
      const successful = responses.flatMap((response) =>
        response.status === "fulfilled" ? [response.value] : [],
      );
      if (!successful.length) {
        const reason = responses.find((response) => response.status === "rejected");
        throw new Error(
          reason?.status === "rejected"
            ? String(reason.reason)
            : "schift_memory_search found no searchable memory buckets.",
        );
      }
      const hits = successful
        .flatMap((response) =>
          hitsFromBucketSearchResponse(response).map((hit) => {
            const memoryHit = {
              ...hit,
              bucket_id: response.bucket_id,
              source:
                typeof hit.metadata?.source === "string"
                  ? hit.metadata.source
                  : response.bucket_id,
            };
            fetchCache.set(hit.id, {
              id: hit.id,
              title: titleForHit(hit),
              text: hit.text,
              url: urlForHit(hit, response.bucket_id),
              bucket_id: response.bucket_id,
              metadata: hit.metadata ?? {},
            });
            return memoryHit;
          }),
        )
        .sort((a, b) => b.score - a.score);
      const out: MemorySearchResponse = {
        query: stringArg(args, "query") ?? "",
        hits,
        bucket_count: successful.length,
        sources_searched: buckets,
      };
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(out, null, 2),
          },
        ],
      };
    }

    if (name === "schift_workflow_list") {
      const out = await callApi<WorkflowV2Summary[]>("/v2/workflows", {}, "schift_workflow_list");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(out, null, 2),
          },
        ],
      };
    }

    if (name === "schift_workflow_dry_run") {
      const { workflowId, body } = workflowRunBodyFromArgs(args);
      const out = await callApi(
        `/v2/workflows/${encodeURIComponent(workflowId)}/dry-run`,
        {
          method: "POST",
          body: JSON.stringify(body),
        },
        "schift_workflow_dry_run",
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(out, null, 2),
          },
        ],
      };
    }

    if (name === "schift_workflow_run") {
      const { workflowId, body } = workflowRunBodyFromArgs(args);
      let out: WorkflowV2RunResult;
      try {
        out = await callApi<WorkflowV2RunResult>(
          `/v2/workflows/${encodeURIComponent(workflowId)}/run`,
          {
            method: "POST",
            body: JSON.stringify(body),
          },
          "schift_workflow_run",
        );
      } catch (error) {
        if (String(error).includes("schift API 409")) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "needs_review",
                    workflow_id: workflowId,
                    message:
                      "This workflow is not published yet. A human must review and publish it in the Schift console before agents can run it.",
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        throw error;
      }
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(out, null, 2),
          },
        ],
      };
    }

    if (name === "schift_memory_list_sources") {
      const params = new URLSearchParams();
      if (config.userId) params.set("user_id", config.userId);
      const out = await callApi<{ sources: SourceListEntry[] }>(
        `/v1/sources?${params.toString()}`,
        {},
        "schift_memory_list_sources",
      );
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(out.sources, null, 2),
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  });

  return server;
}
