import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
});
