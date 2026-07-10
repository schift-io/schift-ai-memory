import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";

import { ContainerError, effectiveView, parseCclgContainer, UnknownPatchOperationError } from "../dist/index.js";

// Golden conformance fixtures mirrored from the CCLG repo (canonical Python
// implementation), tests/conformance/ at commit
// 51fbd242af317dab302cc0a0bfd405c6ae64ee6c -- see fixtures/cclg-conformance/README.md
// for provenance and re-sync instructions. These exercise this package's TS
// port of CCLG's effective-view semantics (cclg-effective-view.ts) against the
// same expectations the Python implementation is held to, to catch drift
// between the two (e.g. RETIRING_PATCH_OPERATIONS set divergence).
const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cclg-conformance");

async function loadFixture(baseName) {
  const container = await readFile(join(FIXTURES_DIR, `${baseName}.cclg`));
  const expected = JSON.parse(await readFile(join(FIXTURES_DIR, `${baseName}.expected.json`), "utf8"));
  return { container, expected };
}

async function conformanceBaseNames() {
  const files = await readdir(FIXTURES_DIR);
  return [...new Set(files.filter((name) => name.endsWith(".cclg")).map((name) => name.replace(/\.cclg$/, "")))].sort();
}

describe("CCLG cross-impl conformance (TS port vs Python golden fixtures)", () => {
  it("discovers all 8 golden fixture pairs", async () => {
    const baseNames = await conformanceBaseNames();
    assert.equal(baseNames.length, 8, `expected 8 conformance fixtures, found: ${baseNames.join(", ")}`);
  });

  const positiveCases = [
    "01_supersede_chain",
    "02_create_then_retire",
    "03_scope_precedence",
    "04_forget_expire_deprecate",
    "05_conflict_pending_resolve",
    "06_rollback_non_retiring",
  ];

  for (const baseName of positiveCases) {
    it(`${baseName}: effective view matches golden expectation`, async () => {
      const { container, expected } = await loadFixture(baseName);
      const bundle = parseCclgContainer(container);
      const active = effectiveView(bundle.nodes, bundle.patches, expected.session_id ?? undefined);
      const activeIds = active.map((node) => node.id).sort();
      const expectedIds = [...expected.effective_view_node_ids].sort();
      assert.deepEqual(activeIds, expectedIds, expected.description);
    });
  }

  it("07_unknown_patch_operation: fails at default (validate=true) load", async () => {
    const { container } = await loadFixture("07_unknown_patch_operation");
    assert.throws(
      () => parseCclgContainer(container),
      (error) => error instanceof ContainerError,
      "an operation outside the closed PATCH_OPERATIONS set must be rejected by schema validation at load time",
    );
  });

  it("07_unknown_patch_operation: fails at effective-view computation even with validate=false", async () => {
    const { container } = await loadFixture("07_unknown_patch_operation");
    const bundle = parseCclgContainer(container, { validate: false });
    assert.throws(
      () => effectiveView(bundle.nodes, bundle.patches),
      (error) => error instanceof UnknownPatchOperationError,
      "effectiveView() must fail-closed on an operation outside KNOWN_PATCH_OPERATIONS, independent of schema validation",
    );
  });

  it("08_forbidden_auth_field: fails at load regardless of validate=", async () => {
    const { container } = await loadFixture("08_forbidden_auth_field");
    for (const validate of [true, false]) {
      assert.throws(
        () => parseCclgContainer(container, { validate }),
        (error) => error instanceof ContainerError && /forbidden auth field/.test(error.message),
        `validate=${validate} must still reject a container carrying a forbidden auth field`,
      );
    }
  });
});
