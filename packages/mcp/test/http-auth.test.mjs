import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { validateUpstreamBearer } from "../dist/http-auth.js";

describe("Schift MCP HTTP upstream bearer validation", () => {
  it("accepts a bearer token when the Schift API accepts bucket listing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init = {}) => {
      assert.equal(String(url), "https://api.test/v1/buckets");
      const headers = new Headers(init.headers);
      assert.equal(headers.get("Authorization"), "Bearer valid-token");
      assert.equal(headers.get("X-Schift-Client"), "mcp");
      assert.equal(headers.get("X-Schift-MCP-Version"), "0.2.0");
      return Response.json([]);
    };

    try {
      assert.deepEqual(
        await validateUpstreamBearer({
          apiBaseUrl: "https://api.test",
          apiKey: "valid-token",
        }),
        { ok: true, status: 200 },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("rejects an invalid bearer token before exposing an MCP session", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ detail: "Invalid token" }), { status: 401 });

    try {
      assert.deepEqual(
        await validateUpstreamBearer({
          apiBaseUrl: "https://api.test",
          apiKey: "bad-token",
        }),
        { ok: false, status: 401, error: '{"detail":"Invalid token"}' },
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("fails closed when the upstream API cannot be reached", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("network down");
    };

    try {
      const result = await validateUpstreamBearer({
        apiBaseUrl: "https://api.test",
        apiKey: "maybe-valid-token",
      });
      assert.equal(result.ok, false);
      assert.equal(result.status, 502);
      assert.match(result.error, /upstream_unreachable/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
