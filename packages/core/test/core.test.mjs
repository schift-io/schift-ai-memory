import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  createAiMemoryEvent,
  createCclgAiMemoryEvent,
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
      collection: "__schift_ai_daily_log",
      job: {
        type: "coding",
        title: "Fix login",
        status: "completed",
      },
    });

    assert.equal(event.event_kind, "ai_job_summary");
    assert.equal(event.content_policy.raw_transcript, false);
    assert.equal(event.collection, "__schift_ai_daily_log");
    assert.equal(event.content_policy.artifacts, "selected");
    assert.deepEqual(event.tags, ["source:codex", "job:coding"]);
  });

  it("wraps CCLG payloads in a Schift AI memory event", () => {
    const event = createCclgAiMemoryEvent({
      source: "codex",
      harness: "codex-plugin",
      org_id: "org_1",
      user_id: "user_1",
      company_bucket: "default",
      collection: "__schift_ai_daily_log",
      job: {
        type: "coding",
        title: "Adopt CCLG",
        status: "completed",
      },
      cclg: {
        schema_version: "cclg.active_memory_pack.v0.1",
        session_id: "session_1",
        node_ids: ["mem_1"],
        patch_ids: ["patch_1"],
        source_labels: ["manual:quickstart"],
        summary: "Keep CCLG as the memory payload.",
      },
    });

    assert.equal(event.summary, "Keep CCLG as the memory payload.");
    assert.equal(event.schema_version, "schift.ai_memory_envelope.v0.1");
    assert.equal(event.kind, "cclg_session_summary");
    assert.equal(event.schift.bucket, "default");
    assert.equal(event.schift.collection, "__schift_ai_daily_log");
    assert.equal(event.schift.upload_policy, "summary_metadata_only");
    assert.equal(event.cclg.schema_version, "cclg.active_memory_pack.v0.1");
    assert.equal(event.metadata.cclg.schema_version, "cclg.active_memory_pack.v0.1");
    assert.deepEqual(event.metadata.cclg.source_labels, ["manual:quickstart"]);
    assert.deepEqual(event.tags, ["source:codex", "job:coding", "format:cclg"]);
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
        metadata: {
          note: "email a@example.com",
        },
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

  it("redacts CCLG payloads before enqueueing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "schift-ai-memory-cclg-"));
    try {
      const event = createCclgAiMemoryEvent({
        source: "codex",
        harness: "codex-plugin",
        summary: "Keep safe",
        job: { type: "coding", title: "Summarize CCLG", status: "completed" },
        cclg: {
          schema_version: "cclg.active_memory_pack.v0.1",
          session_id: "session_1",
          source_labels: ["owner a@example.com"],
          summary: "Used Bearer abcdefghijklmnopqrstuvwxyz12345",
        },
      });
      const file = await enqueueEvent(dir, event);
      const content = await readFile(file, "utf8");
      assert.match(content, /Bearer \[REDACTED_TOKEN\]/);
      assert.match(content, /\[REDACTED_EMAIL\]/);
      assert.doesNotMatch(content, /abcdefghijklmnopqrstuvwxyz12345/);
      assert.doesNotMatch(content, /a@example.com/);
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
        return Response.json([{ id: "collection_1", name: "__schift_ai_daily_log" }], { status: 200 });
      }
      assert.equal(String(url), "https://api.test/v1/buckets/bucket_1/upload");
      assert.ok(init.body instanceof FormData);
      const metadata = JSON.parse(String(init.body.get("metadata")));
      assert.equal(metadata.collection, "__schift_ai_daily_log");
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
          collection: "__schift_ai_daily_log",
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

  it("uploads CCLG envelope documents with searchable CCLG metadata", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      if (String(url) === "https://api.test/v1/buckets") {
        return Response.json([{ id: "bucket_1", name: "default" }], { status: 200 });
      }
      if (String(url) === "https://api.test/v1/buckets/bucket_1/collections") {
        return Response.json([{ id: "collection_1", name: "__schift_ai_daily_log" }], { status: 200 });
      }
      assert.equal(String(url), "https://api.test/v1/buckets/bucket_1/upload");
      assert.ok(init.body instanceof FormData);
      const metadata = JSON.parse(String(init.body.get("metadata")));
      assert.equal(metadata.envelope_schema_version, "schift.ai_memory_envelope.v0.1");
      assert.equal(metadata.envelope_kind, "cclg_session_summary");
      assert.equal(metadata.memory_format, "cclg");
      assert.equal(metadata.cclg_schema_version, "cclg.active_memory_pack.v0.1");
      assert.equal(metadata.cclg_session_id, "session_1");
      assert.equal(metadata.cclg_node_ids, "mem_1,mem_2");
      assert.equal(metadata.cclg_patch_ids, "patch_1");
      assert.equal(metadata.cclg_source_labels, "manual:quickstart,codex:session");

      const file = init.body.get("files");
      assert.ok(file instanceof Blob);
      const body = JSON.parse(await file.text());
      assert.equal(body.schema_version, "schift.ai_memory_envelope.v0.1");
      assert.equal(body.kind, "cclg_session_summary");
      assert.equal(body.schift.upload_policy, "summary_metadata_only");
      assert.equal(body.cclg.schema_version, "cclg.active_memory_pack.v0.1");
      assert.deepEqual(body.cclg.node_ids, ["mem_1", "mem_2"]);
      assert.equal(body.cclg.summary, "Used [REDACTED_EMAIL]");
      return Response.json({ id: "doc_1" }, { status: 201 });
    };

    try {
      const result = await uploadEvent({
        apiBaseUrl: "https://api.test",
        apiKey: "sk-test",
        event: createCclgAiMemoryEvent({
          source: "codex",
          harness: "codex-plugin",
          company_bucket: "default",
          collection: "__schift_ai_daily_log",
          session_id: "session_1",
          summary: "Upload CCLG envelope",
          job: { type: "coding", title: "Upload CCLG", status: "completed" },
          cclg: {
            schema_version: "cclg.active_memory_pack.v0.1",
            session_id: "session_1",
            node_ids: ["mem_1", "mem_2"],
            patch_ids: ["patch_1"],
            source_labels: ["manual:quickstart", "codex:session"],
            summary: "Used a@example.com",
          },
        }),
      });
      assert.deepEqual(result, { ok: true, status: 201, id: "doc_1" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uses configured collection ids without listing collections", async () => {
    const originalFetch = globalThis.fetch;
    const urls = [];
    globalThis.fetch = async (url, init = {}) => {
      urls.push(String(url));
      if (String(url) === "https://api.test/v1/buckets") {
        return Response.json([{ id: "bucket_1", name: "default" }], { status: 200 });
      }
      assert.equal(String(url), "https://api.test/v1/buckets/bucket_1/upload");
      assert.ok(init.body instanceof FormData);
      assert.equal(init.body.get("collection_id"), "collection_from_login");
      return Response.json({ jobs: [{ job_id: "job_1" }] }, { status: 201 });
    };

    try {
      const result = await uploadEvent({
        apiBaseUrl: "https://api.test",
        apiKey: "sk-test",
        collectionId: "collection_from_login",
        event: createAiMemoryEvent({
          source: "codex",
          harness: "codex-plugin",
          company_bucket: "default",
          collection: "__schift_ai_daily_log",
          job: { type: "coding", title: "Upload", status: "completed" },
        }),
      });

      assert.deepEqual(result, { ok: true, status: 201, id: "job_1" });
      assert.deepEqual(urls, [
        "https://api.test/v1/buckets",
        "https://api.test/v1/buckets/bucket_1/upload",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("uploads to a configured bucket id without listing buckets", async () => {
    const originalFetch = globalThis.fetch;
    const bucketId = "0123456789abcdef0123456789abcdef";
    globalThis.fetch = async (url, init = {}) => {
      assert.equal(String(url), `https://api.test/v1/buckets/${bucketId}/upload`);
      assert.ok(init.body instanceof FormData);
      assert.equal(init.body.get("collection_id"), "session_collection");
      return Response.json({ jobs: [{ job_id: "job_session" }] }, { status: 201 });
    };
    try {
      const result = await uploadEvent({
        apiBaseUrl: "https://api.test",
        apiKey: "sk-test",
        collectionId: "session_collection",
        event: createAiMemoryEvent({
          source: "codex",
          harness: "codex-plugin",
          company_bucket: bucketId,
          collection: "__schift_ai_daily_log",
          job: { type: "coding", title: "Upload session", status: "completed" },
        }),
      });
      assert.deepEqual(result, { ok: true, status: 201, id: "job_session" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
