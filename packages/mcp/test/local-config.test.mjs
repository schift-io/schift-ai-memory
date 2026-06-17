import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { readMcpConfigFromEnv } from "../dist/local-config.js";

describe("Schift MCP local AI Memory config", () => {
  it("uses the login config as the default MCP credential source", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schift-mcp-config-"));
    const originalEnv = { ...process.env };
    try {
      const configPath = join(dir, "config.json");
      await writeFile(
        configPath,
        `${JSON.stringify({
          api_base_url: "https://api.test",
          api_key: "sch_local",
          bucket: "default",
          collection: "__schift_ai_daily_log",
          identity: {
            user_id: "usr_123",
          },
        })}\n`,
        "utf8",
      );
      delete process.env.SCHIFT_API_KEY;
      delete process.env.SCHIFT_API_BASE_URL;
      delete process.env.SCHIFT_DEFAULT_BUCKET;
      delete process.env.SCHIFT_USER_ID;
      delete process.env.SCHIFT_MEMORY_BUCKETS;
      process.env.SCHIFT_AI_MEMORY_CONFIG = configPath;

      assert.deepEqual(readMcpConfigFromEnv(), {
        apiBaseUrl: "https://api.test",
        apiKey: "sch_local",
        userId: "usr_123",
        defaultBucket: "default",
        memoryBuckets: undefined,
      });
    } finally {
      process.env = originalEnv;
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps explicit MCP env values ahead of local config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schift-mcp-config-"));
    const originalEnv = { ...process.env };
    try {
      const configPath = join(dir, "config.json");
      await writeFile(
        configPath,
        `${JSON.stringify({
          api_key: "sch_local",
          bucket: "default",
          identity: {
            user_id: "usr_local",
          },
        })}\n`,
        "utf8",
      );
      process.env.SCHIFT_AI_MEMORY_CONFIG = configPath;
      process.env.SCHIFT_API_KEY = "sch_env";
      process.env.SCHIFT_API_BASE_URL = "https://api.env";
      process.env.SCHIFT_DEFAULT_BUCKET = "docs";
      process.env.SCHIFT_USER_ID = "usr_env";
      process.env.SCHIFT_MEMORY_BUCKETS = "default,docs";

      assert.deepEqual(readMcpConfigFromEnv(), {
        apiBaseUrl: "https://api.env",
        apiKey: "sch_env",
        userId: "usr_env",
        defaultBucket: "docs",
        memoryBuckets: ["default", "docs"],
      });
    } finally {
      process.env = originalEnv;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
