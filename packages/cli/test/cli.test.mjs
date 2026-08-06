import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const execFileAsync = promisify(execFile);

describe("schift-ai-memory CLI", () => {
  it("prints an install plan for supported harnesses", async () => {
    const { stdout } = await execFileAsync("node", ["dist/cli.js", "init", "--print", "--bucket", "company:room821"]);
    const plan = JSON.parse(stdout);
    assert.equal(plan.company_bucket, "company:room821");
    assert.equal(plan.collection, "__schift_ai_daily_log");
    assert.match(plan.install.codex, /codex plugin marketplace add/);
    assert.equal(plan.upload_policy, "summary_metadata_only");
    assert.equal(plan.role_package.id, "schift.coding-agent.default");
    assert.equal(plan.role_package.persona, "coding-agent");
    assert.deepEqual(plan.role_package.security.required_scopes, [
      "ai_memory:read",
      "ai_memory:write",
      "buckets:read",
      "buckets:upload",
    ]);
    assert.ok(plan.role_package.tools.mcp.includes("search"));
    assert.ok(plan.role_package.tools.mcp.includes("fetch"));
    assert.ok(plan.role_package.tools.mcp.includes("schift_memory_search"));
    assert.ok(plan.role_package.tools.disabled_by_default.includes("schift_workflow_run"));
    assert.equal(plan.install.cursor_mcp.mcpServers.schift.env.SCHIFT_DEFAULT_BUCKET, "company:room821");
    assert.equal(plan.install.cursor_mcp.mcpServers.schift.env.SCHIFT_API_KEY, undefined);
  });

  it("runs init as a guided setup when login is skipped", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schift-ai-memory-cli-"));
    const output = join(dir, "claude-settings.json");
    const { stdout } = await execFileAsync("node", [
      "dist/cli.js",
      "init",
      "--no-login",
      "--bucket",
      "company:room821",
      "--output",
      output,
    ]);
    assert.match(stdout, /initializing AI Memory/);
    assert.match(stdout, /skipped OAuth login/);
    // 훅은 이제 **실제로 설치**된다(예전엔 예제 파일만 쓰고 "wrote"만 찍었다).
    // --output 을 준 경우에도 설치 경로로 간다.
    assert.match(stdout, /installed hooks into|wrote/);
    assert.match(stdout, /codex plugin marketplace add/);

    const settings = JSON.parse(await readFile(output, "utf8"));
    assert.equal(settings.env.SCHIFT_COMPANY_BUCKET, "company:room821");
    assert.equal(settings.env.SCHIFT_COLLECTION, "__schift_ai_daily_log");
  });

  it("reports login status through doctor without requiring network when config is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schift-ai-memory-cli-"));
    const { stdout } = await execFileAsync("node", ["dist/cli.js", "doctor"], {
      env: {
        ...process.env,
        SCHIFT_AI_MEMORY_CONFIG: join(dir, "missing-config.json"),
      },
    });
    const result = JSON.parse(stdout);
    assert.equal(result.status, "needs_login");
    assert.equal(result.checks[0].name, "config");
    assert.equal(result.checks[0].status, "failed");
    assert.match(result.next_action, /@schift-io\/ai-memory login/);
  });

  it("prints a metadata example", async () => {
    const { stdout } = await execFileAsync("node", ["dist/cli.js", "metadata-example"]);
    const event = JSON.parse(stdout);
    assert.equal(event.source, "codex");
    assert.equal(event.content_policy.raw_transcript, false);
  });
});
