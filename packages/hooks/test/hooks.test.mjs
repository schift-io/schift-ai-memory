import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

function runHook(args, input, env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", ["dist/cli.js", ...args], { env });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`hook exited ${code}: ${stderr}`));
    });
    child.stdin.end(input);
  });
}

describe("AI memory hooks", () => {
  it("queues a redacted Codex stop event without failing the host", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schift-ai-memory-hooks-"));
    try {
      await runHook(
        ["codex-stop"],
        JSON.stringify({
          session_id: "sess_1",
          prompt: "Fix token sk-abc1234567890abc1234567890abc",
          cwd: "/Users/alice/Projects/schift",
        }),
        {
          ...process.env,
          SCHIFT_AI_MEMORY_QUEUE_DIR: dir,
          SCHIFT_COMPANY_BUCKET: "company:room821",
        },
      );
      const files = await readdir(dir);
      assert.equal(files.length, 1);
      const queued = JSON.parse(await readFile(join(dir, files[0]), "utf8"));
      assert.equal(queued.source, "codex");
      assert.match(queued.job.title, /\[REDACTED_OPENAI_KEY\]/);
      assert.equal(queued.company_bucket, "company:room821");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uses cached identity and security metadata from local config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schift-ai-memory-hooks-"));
    try {
      const configPath = join(dir, "config.json");
      await writeFile(
        configPath,
        `${JSON.stringify({
          api_key: "sch_test",
          bucket: "default",
          collection: "__schift_ai_daily_log",
          identity: {
            org_id: "org_123",
            user_id: "usr_456",
          },
          security: {
            level: "standard",
            policy_version: "2026-06-17",
          },
          status: "connected",
          verified_at: "2026-06-17T00:00:00.000Z",
          refresh_after: "2999-01-01T00:00:00.000Z",
        })}\n`,
        "utf8",
      );

      await runHook(
        ["claude-stop"],
        JSON.stringify({
          session_id: "sess_2",
          prompt: "Summarize local config identity",
        }),
        {
          ...process.env,
          SCHIFT_AI_MEMORY_QUEUE_DIR: dir,
          SCHIFT_AI_MEMORY_CONFIG: configPath,
          SCHIFT_AI_MEMORY_UPLOAD: "0",
        },
      );

      const files = (await readdir(dir)).filter((name) => name.endsWith(".json") && name !== "config.json");
      assert.equal(files.length, 1);
      const queued = JSON.parse(await readFile(join(dir, files[0]), "utf8"));
      assert.equal(queued.org_id, "org_123");
      assert.equal(queued.user_id, "usr_456");
      assert.equal(queued.collection, "__schift_ai_daily_log");
      assert.equal(queued.metadata.config_metadata.has_org_id, true);
      assert.equal(queued.metadata.config_metadata.has_user_id, true);
      assert.deepEqual(queued.metadata.cached_security, {
        level: "standard",
        policy_version: "2026-06-17",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("marks cached credentials invalid on upload auth failure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schift-ai-memory-hooks-"));
    const server = createServer((_req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ detail: "revoked" }));
    });
    try {
      await new Promise((resolve, reject) => {
        server.listen(0, "127.0.0.1", resolve);
        server.on("error", reject);
      });
      const address = server.address();
      assert.equal(typeof address, "object");
      const apiBaseUrl = `http://127.0.0.1:${address.port}`;
      const configPath = join(dir, "config.json");
      await writeFile(
        configPath,
        `${JSON.stringify({
          api_base_url: apiBaseUrl,
          api_key: "sch_revoked",
          bucket: "default",
          collection: "__schift_ai_daily_log",
          identity: {
            org_id: "org_123",
            user_id: "usr_456",
          },
          status: "connected",
        })}\n`,
        "utf8",
      );

      await runHook(
        ["codex-stop"],
        JSON.stringify({
          prompt: "Trigger auth failure",
        }),
        {
          ...process.env,
          SCHIFT_AI_MEMORY_QUEUE_DIR: dir,
          SCHIFT_AI_MEMORY_CONFIG: configPath,
        },
      );

      const updatedConfig = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(updatedConfig.status, "revoked_or_invalid");
      assert.equal(updatedConfig.last_upload_error.status, 401);
      assert.match(updatedConfig.last_upload_error.error, /revoked/);

      const files = (await readdir(dir)).filter((name) => name.endsWith(".json") && name !== "config.json");
      assert.equal(files.length, 1);
    } finally {
      await rm(dir, { recursive: true, force: true });
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
