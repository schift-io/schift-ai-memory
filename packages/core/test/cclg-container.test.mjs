import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { ContainerError, createCclgAiMemoryEventFromContainer, effectiveView, parseCclgContainer } from "../dist/index.js";

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

async function readFixture(name) {
  return readFile(join(FIXTURES_DIR, name));
}

describe(".cclg container loader", () => {
  it("round-trips a nodes+patch container losslessly", async () => {
    const bytes = await readFixture("three-nodes-one-supersede.cclg");
    const bundle = parseCclgContainer(bytes);

    assert.equal(bundle.header.container, "cclg.container.v0.1");
    assert.deepEqual(bundle.counts, { nodes: 3, patches: 1, edges: 0, sessions: 0 });
    assert.equal(bundle.nodes.length, 3);
    assert.equal(bundle.patches.length, 1);
    assert.equal(bundle.warnings.length, 0);

    const [n1, n2, n3] = bundle.nodes;
    assert.equal(n1.status, "superseded");
    assert.equal(n2.status, "active");
    assert.equal(n3.status, "active");

    const [patch] = bundle.patches;
    assert.equal(patch.operation, "supersede");
    assert.deepEqual(patch.target_ids, [n1.id]);
    assert.equal(patch.new_content, "Uses npm (not pnpm) for the frontend package manager.");
  });

  it("detects a tampered checksum", async () => {
    const bytes = await readFixture("three-nodes-one-supersede.cclg");
    const text = bytes.toString("utf8");
    // Flip one character inside a record line (well after the header), which
    // changes the body without touching the header's declared content_sha256.
    const tamperedIndex = text.indexOf("Prefers dark mode");
    assert.ok(tamperedIndex > 0, "fixture must contain the node content we intend to tamper with");
    const tampered = `${text.slice(0, tamperedIndex)}XXXXXX${text.slice(tamperedIndex + 6)}`;

    assert.throws(
      () => parseCclgContainer(Buffer.from(tampered, "utf8")),
      (error) => error instanceof ContainerError && /checksum mismatch/.test(error.message),
    );
  });

  it("skips unknown sections with a warning, still loading known sections", async () => {
    const bytes = await readFixture("three-nodes-one-supersede-unknown-section.cclg");
    const bundle = parseCclgContainer(bytes);

    assert.equal(bundle.nodes.length, 3);
    assert.equal(bundle.patches.length, 1);
    assert.ok(bundle.unknownSections.future_section, "unknown section should be captured, not dropped");
    assert.equal(bundle.unknownSections.future_section.length, 1);
    assert.deepEqual(bundle.unknownSections.future_section[0], { note: "future data, unknown to this reader" });
    assert.ok(bundle.warnings.some((warning) => warning.includes("unknown section '@future_section' skipped")));
  });

  it("rejects a bad magic line", () => {
    assert.throws(
      () => parseCclgContainer(Buffer.from("NOTCCLG\t0.1\n{}\n", "utf8")),
      (error) => error instanceof ContainerError && /bad magic/.test(error.message),
    );
  });

  it("rejects an unsupported container version", () => {
    assert.throws(
      () => parseCclgContainer(Buffer.from("CCLG\t0.2\n{}\n", "utf8")),
      (error) => error instanceof ContainerError && /unsupported container version/.test(error.message),
    );
  });
});

describe("effectiveView", () => {
  it("excludes the node retired by a supersede patch, keeps unrelated active nodes", async () => {
    const bytes = await readFixture("three-nodes-one-supersede.cclg");
    const bundle = parseCclgContainer(bytes);

    const active = effectiveView(bundle.nodes, bundle.patches);
    const activeIds = active.map((node) => node.id).sort();
    const [superseded, n2, n3] = bundle.nodes;

    assert.equal(active.length, 2);
    assert.deepEqual(activeIds, [n2.id, n3.id].sort());
    assert.ok(!activeIds.includes(superseded.id));
  });

  it("preserves patches as data even though they are not part of the active projection", async () => {
    const bytes = await readFixture("three-nodes-one-supersede.cclg");
    const bundle = parseCclgContainer(bytes);
    effectiveView(bundle.nodes, bundle.patches);

    // effectiveView must not mutate its inputs -- the patch/edge ledger is
    // preserved as first-class data regardless of what the projection computes.
    assert.equal(bundle.patches.length, 1);
    assert.equal(bundle.patches[0].operation, "supersede");
  });
});

describe("createCclgAiMemoryEventFromContainer", () => {
  it("preserves the whole container verbatim while deriving a search-friendly projection", async () => {
    const bytes = await readFixture("three-nodes-one-supersede.cclg");
    const originalText = bytes.toString("utf8");

    const event = createCclgAiMemoryEventFromContainer({
      source: "codex",
      harness: "codex-plugin",
      company_bucket: "default",
      collection: "__schift_ai_daily_log",
      job: { type: "coding", title: "Adopt CCLG container loader", status: "completed" },
      container: bytes,
    });

    assert.equal(event.schema_version, "schift.ai_memory_envelope.v0.1");
    assert.equal(event.kind, "cclg_session_summary");
    assert.equal(event.cclg.container_format, "cclg.container.v0.1");
    assert.equal(event.cclg.container_text, originalText, "container_text must be byte-for-byte verbatim (no redaction triggers in this fixture)");
    assert.deepEqual(event.cclg.counts, { nodes: 3, patches: 1, edges: 0, sessions: 0 });
    assert.equal(event.cclg.patch_ids.length, 1);
    assert.equal(event.cclg.node_ids.length, 2, "node_ids should reflect the effectiveView projection, excluding the superseded node");
    assert.ok(event.cclg.summary.length > 0);
    // Round-trips through JSON without throwing (the envelope is what actually gets uploaded).
    assert.doesNotThrow(() => JSON.stringify(event));
  });
});
