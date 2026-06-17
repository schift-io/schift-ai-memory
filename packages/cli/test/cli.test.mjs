import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, it } from "node:test";

const execFileAsync = promisify(execFile);

describe("schift-ai-memory CLI", () => {
  it("prints an install plan for supported harnesses", async () => {
    const { stdout } = await execFileAsync("node", ["dist/cli.js", "init", "--bucket", "company:room821"]);
    const plan = JSON.parse(stdout);
    assert.equal(plan.company_bucket, "company:room821");
    assert.equal(plan.collection, "_daily_log");
    assert.match(plan.install.codex, /codex plugin marketplace add/);
    assert.equal(plan.upload_policy, "summary_metadata_only");
  });

  it("prints a metadata example", async () => {
    const { stdout } = await execFileAsync("node", ["dist/cli.js", "metadata-example"]);
    const event = JSON.parse(stdout);
    assert.equal(event.source, "codex");
    assert.equal(event.content_policy.raw_transcript, false);
  });
});
