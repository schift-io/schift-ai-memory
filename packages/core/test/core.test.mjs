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

  it("uploads redacted events to the Schift ingest endpoint", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      assert.equal(String(url), "https://api.test/v1/ai-memory/events");
      const headers = new Headers(init.headers);
      assert.equal(headers.get("Authorization"), "Bearer sk-test");
      assert.equal(headers.get("X-Schift-Client"), "ai-memory");
      const body = JSON.parse(init.body);
      assert.equal(body.summary, "token [REDACTED_OPENAI_KEY]");
      return Response.json({ id: "evt_1" }, { status: 201 });
    };

    try {
      const result = await uploadEvent({
        apiBaseUrl: "https://api.test",
        apiKey: "sk-test",
        event: createAiMemoryEvent({
          source: "codex",
          harness: "codex-plugin",
          summary: "token sk-abc1234567890abc1234567890abc",
          job: { type: "coding", title: "Upload", status: "completed" },
        }),
      });
      assert.deepEqual(result, { ok: true, status: 201, id: "evt_1" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
