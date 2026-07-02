import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import {
  bucketFromArgs,
  bucketSearchBodyFromArgs,
  createServer,
  memorySearchBodyFromArgs,
  uploadFormFromArgs,
} from "../dist/index.js";

describe("Schift MCP search argument mapping", () => {
  it("uses the explicit bucket before the default bucket", () => {
    assert.equal(
      bucketFromArgs({ bucket: "docs" }, { defaultBucket: "fallback" }),
      "docs",
    );
  });

  it("keeps collection as a bucket compatibility alias", () => {
    assert.equal(
      bucketFromArgs({ collection: "legacy-docs" }, {}),
      "legacy-docs",
    );
  });

  it("uses the user's default bucket when no bucket is configured", () => {
    assert.equal(bucketFromArgs({}, {}), "default");
  });

  it("maps MCP search fields to the Schift bucket search body", () => {
    assert.deepEqual(
      bucketSearchBodyFromArgs({
        query: "refund policy",
        top_k: 7,
        sources: ["notion"],
        tags: ["domain:legal", "status:approved"],
        filter: { tenant: "room821" },
        mode: "hybrid",
        rerank: true,
        temporal: "latest",
      }),
      {
        query: "refund policy",
        top_k: 7,
        filters: {
          tenant: "room821",
          domain: "legal",
          status: "approved",
          source: "notion",
        },
        options: {
          rerank: { enabled: true },
        },
      },
    );
  });

  it("maps MCP memory search fields to the user-scoped memory API body", () => {
    assert.deepEqual(
      memorySearchBodyFromArgs({
        query: "what did I promise Acme",
        top_k: 12,
        sources: ["gmail", "notion"],
        tags: ["account:acme"],
        filter: { ignored: "for-memory-api" },
        mode: "hybrid",
        rerank: false,
        temporal: "latest",
      }),
      {
        query: "what did I promise Acme",
        top_k: 12,
        sources: ["gmail", "notion"],
        tags: ["account:acme"],
        rerank: false,
        temporal: "latest",
      },
    );
  });

  it("routes default MCP memory search through the authenticated memory API", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      calls.push({ url: String(url), init });
      assert.equal(String(url), "https://api.test/v1/memory/search");
      assert.equal(init.method, "POST");
      const headers = new Headers(init.headers);
      assert.equal(headers.get("Authorization"), "Bearer user-token");
      assert.equal(headers.get("X-Schift-Client"), "mcp");
      assert.equal(headers.get("X-Schift-MCP-Tool"), "schift_memory_search");
      assert.equal(headers.get("X-Schift-MCP-Version"), "0.2.0");
      assert.deepEqual(JSON.parse(init.body), {
        query: "acme renewal",
        top_k: 3,
        sources: ["gmail"],
        tags: ["account:acme"],
        temporal: "latest",
      });
      return new Response(
        JSON.stringify({
          query: "acme renewal",
          hits: [
            {
              id: "hit_1",
              score: 0.91,
              text: "Acme renewal was promised by Friday.",
              bucket_id: "memory:user_123:gmail",
              source: "gmail",
              metadata: {
                title: "Acme renewal",
                source_url: "https://mail.google.com/mail/u/0/#inbox/hit_1",
              },
            },
          ],
          bucket_count: 1,
          sources_searched: ["gmail"],
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      );
    };

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer({
      apiBaseUrl: "https://api.test",
      apiKey: "user-token",
    });
    const client = new Client({ name: "schift-mcp-test", version: "1.0.0" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "schift_memory_search",
        arguments: {
          query: "acme renewal",
          top_k: 3,
          sources: ["gmail"],
          tags: ["account:acme"],
          temporal: "latest",
        },
      });
      assert.equal(calls.length, 1);
      assert.deepEqual(JSON.parse(result.content[0].text), {
        query: "acme renewal",
        hits: [
          {
            id: "hit_1",
            score: 0.91,
            text: "Acme renewal was promised by Friday.",
            bucket_id: "memory:user_123:gmail",
            source: "gmail",
            metadata: {
              title: "Acme renewal",
              source_url: "https://mail.google.com/mail/u/0/#inbox/hit_1",
            },
          },
        ],
        bucket_count: 1,
        sources_searched: ["gmail"],
      });

      const fetched = await client.callTool({
        name: "fetch",
        arguments: { id: "hit_1" },
      });
      assert.deepEqual(JSON.parse(fetched.content[0].text), {
        id: "hit_1",
        title: "Acme renewal",
        text: "Acme renewal was promised by Friday.",
        url: "https://mail.google.com/mail/u/0/#inbox/hit_1",
        bucket_id: "memory:user_123:gmail",
        metadata: {
          title: "Acme renewal",
          source_url: "https://mail.google.com/mail/u/0/#inbox/hit_1",
        },
      });
    } finally {
      await client.close();
      globalThis.fetch = originalFetch;
    }
  });

  it("surfaces CCLG refs in compact search results", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      const path = new URL(url).pathname;
      if (path === "/v1/buckets") {
        return Response.json([{ id: "bucket_1", name: "default" }]);
      }
      if (path === "/v2/buckets/bucket_1/search") {
        assert.equal(init.method, "POST");
        assert.deepEqual(JSON.parse(init.body), {
          query: "cclg session",
          top_k: 10,
        });
        return Response.json({
          bucket_id: "bucket_1",
          query: "cclg session",
          results: [
            {
              id: "hit_1",
              score: 0.92,
              text: "CCLG session summary",
              metadata: {
                title: "CCLG session",
                cclg_schema_version: "cclg.active_memory_pack.v0.1",
                cclg_session_id: "session_1",
                cclg_node_ids: "mem_1,mem_2",
                cclg_source_labels: "manual:quickstart,codex:session",
              },
            },
          ],
        });
      }
      return new Response("not found", { status: 404 });
    };

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer({
      apiBaseUrl: "https://api.test",
      apiKey: "user-token",
    });
    const client = new Client({ name: "schift-mcp-test", version: "1.0.0" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.callTool({
        name: "search",
        arguments: { query: "cclg session" },
      });
      assert.deepEqual(JSON.parse(result.content[0].text), {
        results: [
          {
            id: "hit_1",
            title: "CCLG session",
            url: "schift://bucket/bucket_1/chunks/hit_1",
            cclg: {
              schema_version: "cclg.active_memory_pack.v0.1",
              session_id: "session_1",
              node_ids: ["mem_1", "mem_2"],
              source_labels: ["manual:quickstart", "codex:session"],
            },
          },
        ],
      });
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      globalThis.fetch = originalFetch;
    }
  });

  it("builds a multipart upload form from text content", async () => {
    const form = uploadFormFromArgs({
      filename: "note.txt",
      text: "hello upload",
      content_type: "text/plain",
      metadata: { source: "mcp-test" },
      chunk_size: 256,
      chunk_overlap: 20,
    });

    assert.equal(form.get("chunk_size"), "256");
    assert.equal(form.get("chunk_overlap"), "20");
    assert.equal(form.get("metadata"), '{"source":"mcp-test"}');
    const file = form.get("files");
    assert.equal(file.name, "note.txt");
    assert.equal(file.type, "text/plain");
    assert.equal(await file.text(), "hello upload");
  });

  it("uploads a document into the selected bucket", async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];
    globalThis.fetch = async (url, init = {}) => {
      const path = new URL(url).pathname;
      calls.push({ url: String(url), path, init });

      if (path === "/v1/buckets") {
        const headers = new Headers(init.headers);
        assert.equal(headers.get("X-Schift-Client"), "mcp");
        assert.equal(headers.get("X-Schift-MCP-Tool"), "schift_upload_document");
        assert.equal(headers.get("X-Schift-MCP-Version"), "0.2.0");
        return Response.json([{ id: "bucket_1", name: "docs" }]);
      }
      if (path === "/v2/buckets/bucket_1/documents") {
        assert.equal(init.method, "POST");
        const headers = new Headers(init.headers);
        assert.equal(headers.get("Authorization"), "Bearer user-token");
        assert.equal(headers.get("Content-Type"), null);
        assert.equal(headers.get("X-Schift-Client"), "mcp");
        assert.equal(headers.get("X-Schift-MCP-Tool"), "schift_upload_document");
        assert.equal(headers.get("X-Schift-MCP-Version"), "0.2.0");
        assert.ok(init.body instanceof FormData);
        const file = init.body.get("files");
        assert.equal(file.name, "note.txt");
        assert.equal(await file.text(), "upload body");
        assert.equal(init.body.get("metadata"), '{"kind":"note"}');
        return Response.json({
          jobs: [
            {
              job_id: "job_1",
              document_id: "doc_1",
              file_name: "note.txt",
              file_type: "txt",
              status: "queued",
              estimated_cost: 0.001,
            },
          ],
          total_estimated_cost: 0.001,
        });
      }
      return new Response("not found", { status: 404 });
    };

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer({
      apiBaseUrl: "https://api.test",
      apiKey: "user-token",
    });
    const client = new Client({ name: "schift-mcp-test", version: "1.0.0" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const tools = await client.listTools();
      assert.ok(
        tools.tools.some((tool) => tool.name === "schift_upload_document"),
        "missing upload tool",
      );

      const uploaded = await client.callTool({
        name: "schift_upload_document",
        arguments: {
          bucket: "docs",
          filename: "note.txt",
          text: "upload body",
          metadata: { kind: "note" },
        },
      });
      assert.deepEqual(JSON.parse(uploaded.content[0].text), {
        jobs: [
          {
            job_id: "job_1",
            document_id: "doc_1",
            file_name: "note.txt",
            file_type: "txt",
            status: "queued",
            estimated_cost: 0.001,
          },
        ],
        total_estimated_cost: 0.001,
      });
      assert.deepEqual(calls.map((call) => call.path), [
        "/v1/buckets",
        "/v2/buckets/bucket_1/documents",
      ]);
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      globalThis.fetch = originalFetch;
    }
  });
});
