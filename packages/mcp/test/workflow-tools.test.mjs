import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer, workflowRunBodyFromArgs } from "../dist/index.js";

describe("Schift MCP workflow argument mapping", () => {
  it("requires a workflow id", () => {
    assert.throws(() => workflowRunBodyFromArgs({}), /non-empty `workflow_id`/);
  });

  it("accepts workflowId as a compatibility alias and defaults inputs", () => {
    assert.deepEqual(workflowRunBodyFromArgs({ workflowId: "wfv2_abc" }), {
      workflowId: "wfv2_abc",
      body: { inputs: {} },
    });
  });

  it("passes mode and approvals through to the run body", () => {
    assert.deepEqual(
      workflowRunBodyFromArgs({
        workflow_id: "wfv2_tax",
        mode: "live",
        approvals: { review_issue: true },
      }),
      {
        workflowId: "wfv2_tax",
        body: { inputs: {}, mode: "live", approvals: { review_issue: true } },
      },
    );
  });

  it("rejects unknown run modes", () => {
    assert.throws(
      () => workflowRunBodyFromArgs({ workflow_id: "wfv2_tax", mode: "yolo" }),
      /must be simulate or live/,
    );
  });

  it("passes structured inputs through to the run body", () => {
    assert.deepEqual(
      workflowRunBodyFromArgs({
        workflow_id: "wfv2_tax",
        inputs: { customer: "ABC상사", documentNumber: "T-2026-003" },
      }),
      {
        workflowId: "wfv2_tax",
        body: { inputs: { customer: "ABC상사", documentNumber: "T-2026-003" } },
      },
    );
  });
});

describe("Schift MCP workflow tools", () => {
  it("lists, dry-runs, and runs AWP workflows with the review boundary intact", async () => {
    const originalWorkflowFlag = process.env.SCHIFT_AI_MEMORY_ENABLE_WORKFLOW_TOOLS;
    process.env.SCHIFT_AI_MEMORY_ENABLE_WORKFLOW_TOOLS = "1";
    const originalFetch = globalThis.fetch;
    const calls = [];

    globalThis.fetch = async (url, init = {}) => {
      const path = new URL(url).pathname;
      calls.push({
        path,
        method: init.method ?? "GET",
        body: init.body ?? null,
        headers: new Headers(init.headers),
      });

      if (path === "/v2/workflows") {
        return Response.json([
          {
            id: "wfv2_tax",
            name: "tax-invoice-bolta",
            description: "Bolta 세금계산서 발행",
            status: "draft",
            block_count: 5,
            updated_at: "2026-06-11T00:00:00Z",
            created_at: "2026-06-11T00:00:00Z",
            published_at: null,
          },
        ]);
      }
      if (path === "/v2/workflows/wfv2_tax/dry-run") {
        return Response.json({
          valid: true,
          outputs: { preview: "T-2026-003" },
          block_states: { validate: "ok" },
        });
      }
      if (path === "/v2/workflows/wfv2_tax/run") {
        return new Response("Publish workflow v2 before running", { status: 409 });
      }
      if (path === "/v2/workflows/wfv2_published/run") {
        return Response.json({
          id: "wfv2run_1",
          workflow_id: "wfv2_published",
          org_id: "org_a",
          status: "completed",
          inputs: { customer: "ABC상사" },
          outputs: { issued: true },
          block_states: {},
          error: null,
          started_at: "2026-06-11T00:00:00Z",
          finished_at: "2026-06-11T00:00:01Z",
          created_at: "2026-06-11T00:00:00Z",
        });
      }
      return new Response("not found", { status: 404 });
    };

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const server = createServer({
      apiBaseUrl: "https://api.test",
      apiKey: "org-key",
    });
    const client = new Client({ name: "schift-mcp-test", version: "1.0.0" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const tools = await client.listTools();
      const toolNames = tools.tools.map((tool) => tool.name);
      for (const expected of [
        "schift_workflow_list",
        "schift_workflow_dry_run",
        "schift_workflow_run",
      ]) {
        assert.ok(toolNames.includes(expected), `missing tool ${expected}`);
      }

      const listed = await client.callTool({ name: "schift_workflow_list", arguments: {} });
      const workflows = JSON.parse(listed.content[0].text);
      assert.equal(workflows.length, 1);
      assert.equal(workflows[0].id, "wfv2_tax");
      assert.equal(workflows[0].status, "draft");
      const listCall = calls.find((call) => call.path === "/v2/workflows");
      assert.equal(listCall.headers.get("X-Schift-Client"), "mcp");
      assert.equal(listCall.headers.get("X-Schift-MCP-Tool"), "schift_workflow_list");
      assert.equal(listCall.headers.get("X-Schift-MCP-Version"), "0.2.0");

      const dryRun = await client.callTool({
        name: "schift_workflow_dry_run",
        arguments: { workflow_id: "wfv2_tax", inputs: { customer: "ABC상사" } },
      });
      assert.deepEqual(JSON.parse(dryRun.content[0].text), {
        valid: true,
        outputs: { preview: "T-2026-003" },
        block_states: { validate: "ok" },
      });
      const dryRunCall = calls.find((call) => call.path.endsWith("/dry-run"));
      assert.deepEqual(JSON.parse(dryRunCall.body), { inputs: { customer: "ABC상사" } });
      assert.equal(dryRunCall.headers.get("X-Schift-Client"), "mcp");
      assert.equal(dryRunCall.headers.get("X-Schift-MCP-Tool"), "schift_workflow_dry_run");
      assert.equal(dryRunCall.headers.get("X-Schift-MCP-Version"), "0.2.0");

      const blockedRun = await client.callTool({
        name: "schift_workflow_run",
        arguments: { workflow_id: "wfv2_tax" },
      });
      const blocked = JSON.parse(blockedRun.content[0].text);
      assert.equal(blocked.status, "needs_review");
      assert.equal(blocked.workflow_id, "wfv2_tax");
      assert.match(blocked.message, /review and publish/);

      const run = await client.callTool({
        name: "schift_workflow_run",
        arguments: { workflow_id: "wfv2_published", inputs: { customer: "ABC상사" } },
      });
      const result = JSON.parse(run.content[0].text);
      assert.equal(result.status, "completed");
      assert.equal(result.workflow_id, "wfv2_published");
      assert.deepEqual(result.outputs, { issued: true });

      const authedCall = calls.at(-1);
      assert.equal(authedCall.method, "POST");
      assert.equal(authedCall.headers.get("X-Schift-Client"), "mcp");
      assert.equal(authedCall.headers.get("X-Schift-MCP-Tool"), "schift_workflow_run");
      assert.equal(authedCall.headers.get("X-Schift-MCP-Version"), "0.2.0");
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      globalThis.fetch = originalFetch;
      if (originalWorkflowFlag === undefined) {
        delete process.env.SCHIFT_AI_MEMORY_ENABLE_WORKFLOW_TOOLS;
      } else {
        process.env.SCHIFT_AI_MEMORY_ENABLE_WORKFLOW_TOOLS = originalWorkflowFlag;
      }
    }
  });
});
