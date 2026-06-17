#!/usr/bin/env node
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

function requireEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalCsv(name) {
  return process.env[name]
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseToolJson(result) {
  const first = result.content?.[0];
  if (!first || first.type !== "text") {
    throw new Error("MCP result did not return text content");
  }
  return JSON.parse(first.text);
}

function bucketSet(response) {
  return new Set(
    (response.hits ?? [])
      .map((hit) => hit.bucket_id)
      .filter((bucket) => typeof bucket === "string" && bucket.length > 0),
  );
}

function assertBucketPrefix(label, response, prefix) {
  if (!prefix) return;
  for (const bucket of bucketSet(response)) {
    if (!bucket.startsWith(prefix)) {
      throw new Error(
        `${label} returned bucket ${bucket}, expected prefix ${prefix}`,
      );
    }
  }
}

async function runSearch({ label, serverUrl, token, query, topK, sources, tags }) {
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), {
    requestInit: {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    },
  });
  const client = new Client({
    name: `schift-mcp-memory-smoke-${label}`,
    version: "0.1.0",
  });

  try {
    await client.connect(transport);
    const args = {
      query,
      top_k: topK,
      ...(sources?.length ? { sources } : {}),
      ...(tags?.length ? { tags } : {}),
    };
    const result = await client.callTool({
      name: "schift_memory_search",
      arguments: args,
    });
    return parseToolJson(result);
  } finally {
    await client.close().catch(() => undefined);
  }
}

function summarize(label, response) {
  const buckets = [...bucketSet(response)].sort();
  return {
    label,
    bucket_count: response.bucket_count ?? 0,
    sources_searched: response.sources_searched ?? [],
    hits: response.hits?.length ?? 0,
    buckets,
  };
}

async function main() {
  const serverUrl = requireEnv("SCHIFT_MCP_URL");
  const tokenA = requireEnv("SCHIFT_TOKEN_A");
  const tokenB = requireEnv("SCHIFT_TOKEN_B");
  const query = process.env.SCHIFT_MCP_SMOKE_QUERY?.trim() || "memory smoke";
  const topK = Number.parseInt(process.env.SCHIFT_MCP_SMOKE_TOP_K ?? "10", 10);
  const sources = optionalCsv("SCHIFT_MCP_SMOKE_SOURCES");
  const tags = optionalCsv("SCHIFT_MCP_SMOKE_TAGS");
  const expectedPrefixA = process.env.SCHIFT_EXPECTED_BUCKET_PREFIX_A?.trim();
  const expectedPrefixB = process.env.SCHIFT_EXPECTED_BUCKET_PREFIX_B?.trim();
  const allowSharedBuckets = process.env.SCHIFT_ALLOW_SHARED_BUCKETS === "1";

  if (!Number.isFinite(topK) || topK < 1) {
    throw new Error("SCHIFT_MCP_SMOKE_TOP_K must be a positive integer");
  }

  const [resultA, resultB] = await Promise.all([
    runSearch({
      label: "a",
      serverUrl,
      token: tokenA,
      query,
      topK,
      sources,
      tags,
    }),
    runSearch({
      label: "b",
      serverUrl,
      token: tokenB,
      query,
      topK,
      sources,
      tags,
    }),
  ]);

  assertBucketPrefix("token A", resultA, expectedPrefixA);
  assertBucketPrefix("token B", resultB, expectedPrefixB);

  const bucketsA = bucketSet(resultA);
  const bucketsB = bucketSet(resultB);
  const shared = [...bucketsA].filter((bucket) => bucketsB.has(bucket));
  if (!allowSharedBuckets && shared.length > 0) {
    throw new Error(
      `tokens returned shared buckets (${shared.join(", ")}). Set SCHIFT_ALLOW_SHARED_BUCKETS=1 for org-shared memory.`,
    );
  }

  console.log(JSON.stringify({
    status: "ok",
    query,
    a: summarize("a", resultA),
    b: summarize("b", resultB),
    strict_prefix_check: Boolean(expectedPrefixA || expectedPrefixB),
    shared_bucket_check: !allowSharedBuckets,
  }, null, 2));
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[schift-mcp-memory-smoke] ${message}`);
  process.exit(1);
});
