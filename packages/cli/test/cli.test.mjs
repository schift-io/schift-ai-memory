import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const execFileAsync = promisify(execFile);

/** 이 테스트는 **실제 홈을 절대 건드리면 안 된다**. install 은 감지된 하네스의
 * 설정 파일에 진짜로 쓰기 때문에, 격리 없이 돌리면 개발자의 살아있는
 * ~/.claude/settings.json 과 ~/.codex/hooks.json 이 테스트 실행만으로 바뀐다
 * (실제로 한 번 그렇게 됐다). 홈과 하네스 경로 오버라이드를 전부 임시 디렉터리로
 * 묶고, 존재하지 않게 두어 감지가 아무것도 못 찾게 한다. */
async function isolatedEnv(extra = {}) {
  const home = await mkdtemp(join(tmpdir(), "schift-ai-memory-home-"));
  return {
    home,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CLAUDE_CONFIG_DIR: join(home, "claude"),
      CODEX_HOME: join(home, "codex"),
      SCHIFT_AI_MEMORY_CONFIG: join(home, "config.json"),
      ...extra,
    },
  };
}

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
    const { home, env } = await isolatedEnv();
    const output = join(home, "claude-settings.json");
    const { stdout } = await execFileAsync(
      "node",
      [
        "dist/cli.js",
        "init",
        "--no-login",
        "--bucket",
        "company:room821",
        "--harness",
        "claude-code",
        "--output",
        output,
      ],
      { env },
    );
    assert.match(stdout, /initializing AI Memory/);
    assert.match(stdout, /skipped OAuth login/);
    // 훅은 이제 **실제로 설치**된다(예전엔 예제 파일만 쓰고 "직접 병합하라"고 안내했다).
    assert.match(stdout, /installed \d+ hooks into/);
    assert.match(stdout, /codex plugin marketplace add/);

    const settings = JSON.parse(await readFile(output, "utf8"));
    assert.equal(settings.env.SCHIFT_COMPANY_BUCKET, "company:room821");
    assert.equal(settings.env.SCHIFT_COLLECTION, "__schift_ai_daily_log");
    // 계획이 요구하는 lifecycle 이 전부 걸렸는지. 개수만 세면 어느 하나가
    // 빠져도 통과한다.
    assert.deepEqual(Object.keys(settings.hooks).sort(), [
      "PostCompact",
      "PreCompact",
      "SessionEnd",
      "SessionStart",
      "Stop",
    ]);
  });

  it("is idempotent — reinstalling does not duplicate our hooks", async () => {
    const { home, env } = await isolatedEnv();
    const output = join(home, "claude-settings.json");
    const args = ["dist/cli.js", "install", "--harness", "claude-code", "--output", output];
    await execFileAsync("node", args, { env });
    await execFileAsync("node", args, { env });
    const settings = JSON.parse(await readFile(output, "utf8"));
    for (const [event, groups] of Object.entries(settings.hooks)) {
      assert.equal(groups.length, 1, `${event} should hold exactly one Schift hook group`);
    }
  });

  it("preserves foreign hooks and removes only ours on uninstall", async () => {
    const { home, env } = await isolatedEnv();
    const output = join(home, "claude-settings.json");
    const foreign = { hooks: [{ type: "command", command: "echo someone-elses-hook" }] };
    await writeFile(output, JSON.stringify({ hooks: { Stop: [foreign] } }), "utf8");

    await execFileAsync(
      "node",
      ["dist/cli.js", "install", "--harness", "claude-code", "--output", output],
      { env },
    );
    const installed = JSON.parse(await readFile(output, "utf8"));
    assert.equal(installed.hooks.Stop.length, 2, "foreign hook must survive install");

    // uninstall 은 감지 경로를 쓰므로 하네스 홈을 실제로 만들어 그 안에서 검증한다.
    const claudeDir = join(home, "claude");
    await mkdir(claudeDir, { recursive: true });
    const settingsPath = join(claudeDir, "settings.json");
    await writeFile(settingsPath, JSON.stringify(installed), "utf8");
    await execFileAsync("node", ["dist/cli.js", "uninstall"], { env });

    const after = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.deepEqual(after.hooks.Stop, [foreign], "only Schift hooks should be removed");
  });

  it("reports login status through doctor without requiring network when config is missing", async () => {
    const { home, env } = await isolatedEnv({});
    const { stdout } = await execFileAsync("node", ["dist/cli.js", "doctor"], {
      env: { ...env, SCHIFT_AI_MEMORY_CONFIG: join(home, "missing-config.json") },
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
