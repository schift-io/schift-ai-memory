import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createAiMemoryEvent,
  enqueueEvent,
  redactEvent,
  redactText,
  uploadEvent,
} from "../dist/index.js";

describe("AI memory core", () => {
  it("creates a metadata-first event with conservative defaults", () => {
    const event = createAiMemoryEvent({
      source: "codex",
      harness: "codex-plugin",
      company_bucket: "company:room821",
      collection: "_daily_log",
      job: {
        type: "coding",
        title: "Fix login",
        status: "completed",
      },
    });

    assert.equal(event.event_kind, "ai_job_summary");
    assert.equal(event.content_policy.raw_transcript, false);
    assert.equal(event.collection, "_daily_log");
    assert.equal(event.content_policy.artifacts, "selected");
    assert.deepEqual(event.tags, ["source:codex", "job:coding"]);
  });

  it("redacts common secrets and strict local user paths", () => {
    assert.equal(
      redactText("token sk-abc1234567890abc1234567890abc", "default"),
      "token [REDACTED_OPENAI_KEY]",
    );
    assert.equal(
      redactText("cwd /Users/alice/Projects/acme", "strict"),
      "cwd /Users/[REDACTED_USER]/Projects/acme",
    );
  });

  it("redacts event summaries before enqueueing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schift-ai-memory-"));
    try {
      const event = redactEvent(createAiMemoryEvent({
        source: "claude-code",
        harness: "claude-code-hooks",
        summary: "Used Bearer abcdefghijklmnopqrstuvwxyz12345",
        job: { type: "research", title: "Look up email a@example.com", status: "completed" },
      }));
      const file = await enqueueEvent(dir, event);
      const content = await readFile(file, "utf8");
      assert.match(content, /Bearer \[REDACTED_TOKEN\]/);
      assert.match(content, /\[REDACTED_EMAIL\]/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("uploads redacted events to the Schift bucket upload endpoint", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const headers = new Headers(init.headers);
      assert.equal(headers.get("Authorization"), "Bearer sk-test");
      assert.equal(headers.get("X-Schift-Client"), "ai-memory");
      if (String(url) === "https://api.test/v1/buckets") {
        return Response.json([{ id: "bucket_1", name: "default" }], { status: 200 });
      }
      if (String(url) === "https://api.test/v1/buckets/bucket_1/collections") {
        return Response.json([{ id: "collection_1", name: "_daily_log" }], { status: 200 });
      }
      assert.equal(String(url), "https://api.test/v1/buckets/bucket_1/upload");
      assert.ok(init.body instanceof FormData);
      const metadata = JSON.parse(String(init.body.get("metadata")));
      assert.equal(metadata.collection, "_daily_log");
      assert.equal(metadata.source, "codex");
      assert.equal(metadata.org_id, "org_1");
      assert.equal(metadata.user_id, "user_1");
      assert.equal(init.body.get("collection_id"), "collection_1");
      const file = init.body.get("files");
      assert.ok(file instanceof Blob);
      const body = JSON.parse(await file.text());
      assert.equal(body.summary, "token [REDACTED_OPENAI_KEY]");
      return Response.json({ jobs: [{ job_id: "job_1" }] }, { status: 201 });
    };

    try {
      const result = await uploadEvent({
        apiBaseUrl: "https://api.test",
        apiKey: "sk-test",
        event: createAiMemoryEvent({
          source: "codex",
          harness: "codex-plugin",
          company_bucket: "default",
          collection: "_daily_log",
          org_id: "org_1",
          user_id: "user_1",
          summary: "token sk-abc1234567890abc1234567890abc",
          job: { type: "coding", title: "Upload", status: "completed" },
        }),
      });
      assert.deepEqual(result, { ok: true, status: 201, id: "job_1" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
