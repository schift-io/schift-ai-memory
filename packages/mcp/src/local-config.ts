import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SchiftMcpConfig } from "./index.js";

interface AiMemoryLocalConfig {
  api_base_url?: unknown;
  api_key?: unknown;
  bucket?: unknown;
  collection?: unknown;
  identity?: {
    user_id?: unknown;
  };
  user_id?: unknown;
}

export function defaultAiMemoryConfigPath(): string {
  return process.env.SCHIFT_AI_MEMORY_CONFIG ?? join(homedir(), ".schift", "ai-memory", "config.json");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readLocalConfig(path = defaultAiMemoryConfigPath()): AiMemoryLocalConfig {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AiMemoryLocalConfig;
  } catch {
    return {};
  }
}

function memoryBucketsFromEnv(): string[] | undefined {
  const buckets = process.env.SCHIFT_MEMORY_BUCKETS
    ?.split(",")
    .map((bucket) => bucket.trim())
    .filter(Boolean);
  return buckets?.length ? buckets : undefined;
}

export function readMcpConfigFromEnv(options: {
  apiKey?: string;
  requireApiKey?: boolean;
} = {}): SchiftMcpConfig | undefined {
  const local = readLocalConfig();
  const apiKey = options.apiKey ?? process.env.SCHIFT_API_KEY ?? stringValue(local.api_key);
  if (!apiKey) {
    if (options.requireApiKey === false) return undefined;
    throw new Error(
      `[schift-ai-memory-mcp] SCHIFT_API_KEY is required unless ${defaultAiMemoryConfigPath()} contains api_key. ` +
        "Run `npx -y @schift-io/ai-memory login` first.",
    );
  }
  const apiBaseUrl =
    process.env.SCHIFT_API_BASE_URL ??
    stringValue(local.api_base_url) ??
    "https://api.schift.io";
  const userId =
    process.env.SCHIFT_USER_ID ??
    stringValue(local.identity?.user_id) ??
    stringValue(local.user_id);
  const defaultBucket =
    process.env.SCHIFT_DEFAULT_BUCKET ??
    stringValue(local.bucket) ??
    stringValue(local.collection);
  const memoryBuckets = memoryBucketsFromEnv();
  return { apiBaseUrl, apiKey, userId, defaultBucket, memoryBuckets };
}
