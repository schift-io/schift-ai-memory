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

/** 훅은 SCHIFT_* env 를 설정 파일보다 우선해서 읽는다. 개발자 셸에 그런 변수가
 * 하나라도 떠 있으면(예: SCHIFT_RAG_BUCKET) 테스트가 그 값을 집어 실패하거나 —
 * 더 나쁘게는 — 남의 버킷을 향한 채로 통과한다. 그래서 **SCHIFT_ 로 시작하는 것을
 * 전부 걷어내고** 테스트가 명시한 것만 남긴다.
 *
 * env 를 걷어내는 것만으로는 부족하다: 훅은 env 가 없으면 **개발자의 진짜
 * ~/.schift/ai-memory/config.json** 을 읽어 거기 적힌 버킷·API 키를 쓴다. 그래서
 * 설정 경로도 없는 파일로 기본 고정하고, 필요한 테스트만 자기 설정을 지정한다. */
function hookEnv(overrides) {
  const base = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("SCHIFT_")),
  );
  return {
    ...base,
    SCHIFT_AI_MEMORY_CONFIG: join(tmpdir(), "schift-ai-memory-absent-config.json"),
    ...overrides,
  };
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
        hookEnv({
          SCHIFT_AI_MEMORY_QUEUE_DIR: dir,
          SCHIFT_COMPANY_BUCKET: "company:room821",
          SCHIFT_AI_MEMORY_UPLOAD: "0",
        }),
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
        hookEnv({
          SCHIFT_AI_MEMORY_QUEUE_DIR: dir,
          SCHIFT_AI_MEMORY_CONFIG: configPath,
          SCHIFT_AI_MEMORY_UPLOAD: "0",
        }),
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

  it("keeps lifecycle events in the configured session-memory bucket", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schift-ai-memory-hooks-"));
    try {
      const configPath = join(dir, "config.json");
      await writeFile(
        configPath,
        `${JSON.stringify({
          bucket: "default",
          session_bucket: "agent-hub-session-memory",
          session_bucket_id: "0123456789abcdef0123456789abcdef",
        })}\n`,
        "utf8",
      );
      await runHook(
        ["codex-stop"],
        JSON.stringify({ session_id: "sess_session_memory", prompt: "Store only the session summary" }),
        hookEnv({
          SCHIFT_AI_MEMORY_QUEUE_DIR: dir,
          SCHIFT_AI_MEMORY_CONFIG: configPath,
          SCHIFT_AI_MEMORY_UPLOAD: "0",
        }),
      );
      const files = (await readdir(dir)).filter((name) => name !== "config.json");
      const queued = JSON.parse(await readFile(join(dir, files[0]), "utf8"));
      assert.equal(queued.company_bucket, "0123456789abcdef0123456789abcdef");
      assert.equal(queued.metadata.rag_bucket_role, "session_memory");
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
        hookEnv({
          SCHIFT_AI_MEMORY_QUEUE_DIR: dir,
          SCHIFT_AI_MEMORY_CONFIG: configPath,
        }),
      );

      const updatedConfig = JSON.parse(await readFile(configPath, "utf8"));
      assert.equal(updatedConfig.status, "revoked_or_invalid");
      assert.equal(updatedConfig.last_upload_error.status, 401);
      assert.match(updatedConfig.last_upload_error.error, /revoked/);

      // 401 은 재시도해도 같은 답이 온다. 활성 큐에서 빠지되 **버려지지는 않는다** —
      // 격리에 남아야 "왜 안 올라갔나"를 나중에 물을 수 있다.
      const active = (await readdir(dir)).filter(
        (name) => name.endsWith(".json") && name !== "config.json" && !name.endsWith(".state.json"),
      );
      assert.deepEqual(active, [], "a revoked-key event must not keep spinning in the queue");
      const held = (await readdir(join(dir, "quarantine"))).filter(
        (name) => name.endsWith(".json") && !name.endsWith(".state.json"),
      );
      assert.equal(held.length, 1, "the event is preserved for inspection");
    } finally {
      await rm(dir, { recursive: true, force: true });
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
