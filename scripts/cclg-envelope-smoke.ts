/**
 * Local E2E smoke: real `.cclg` bytes produced by agent-hub's Python export
 * path (scripts/cclg-smoke-fixture.py -> scripts/fixtures/smoke.cclg) fed
 * through the P3 TS consumer (parseCclgContainer + effectiveView via
 * createCclgAiMemoryEventFromContainer).
 *
 * CCLG TODO P2 "Local end-to-end smoke: .cclg -> createCclgAiMemoryEvent
 * envelope" item. Not a unit test against a hand-built TS fixture (that
 * already exists in packages/core/test/core.test.mjs) -- this is the
 * cross-language interop check: does the real Python producer's output
 * actually parse and project correctly in the TS consumer.
 *
 * Run (after `cclg-smoke-fixture.py` has written the fixture + meta):
 *   node --experimental-strip-types derivatives/schift-ai-memory/scripts/cclg-envelope-smoke.ts
 * or, if that flag is unavailable on the local node version:
 *   npx tsx derivatives/schift-ai-memory/scripts/cclg-envelope-smoke.ts
 *
 * Prints PASS/FAIL per check; exits 0 only if every check passed.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createCclgAiMemoryEventFromContainer,
  parseCclgContainer,
} from "../packages/core/dist/index.js";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(SCRIPT_DIR, "fixtures");

interface SmokeMeta {
  session_id: string;
  revenue_fact_memory_id: string;
  meeting_fact_memory_id: string;
  memories_appended_count: number;
  active_substring_present: string;
  superseded_substring_absent: string;
  expected_container_node_count: number;
  expected_container_patch_count: number;
  expected_active_node_count: number;
}

type CheckResult = { name: string; pass: boolean; detail?: string };

const results: CheckResult[] = [];

function check(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  const status = pass ? "PASS" : "FAIL";
  console.log(`${status}: ${name}${detail ? ` -- ${detail}` : ""}`);
}

async function main(): Promise<void> {
  let containerBytes: Buffer;
  let meta: SmokeMeta;
  try {
    containerBytes = await readFile(join(FIXTURES_DIR, "smoke.cclg"));
  } catch (error) {
    check("fixture readable", false, `run cclg-smoke-fixture.py first: ${String(error)}`);
    finish();
    return;
  }
  try {
    meta = JSON.parse(await readFile(join(FIXTURES_DIR, "smoke.meta.json"), "utf8")) as SmokeMeta;
  } catch (error) {
    check("fixture meta readable", false, `run cclg-smoke-fixture.py first: ${String(error)}`);
    finish();
    return;
  }
  check("fixture + meta readable", true, `${containerBytes.length} bytes`);

  // Step 1: parseCclgContainer -- checksum + structural validation must pass
  // on real Python-produced bytes (not just the hand-built TS fixtures).
  let bundle: ReturnType<typeof parseCclgContainer>;
  try {
    bundle = parseCclgContainer(containerBytes);
    check("parseCclgContainer: checksum + schema validation passes on real Python-produced bytes", true);
  } catch (error) {
    check("parseCclgContainer: checksum + schema validation passes on real Python-produced bytes", false, String(error));
    finish();
    return;
  }

  check(
    "container node/patch counts match producer's declared counts",
    bundle.counts.nodes === meta.expected_container_node_count &&
      bundle.counts.patches === meta.expected_container_patch_count,
    `nodes=${bundle.counts.nodes} (want ${meta.expected_container_node_count}), patches=${bundle.counts.patches} (want ${meta.expected_container_patch_count})`,
  );

  // Step 2: createCclgAiMemoryEventFromContainer -- the actual envelope builder.
  const event = createCclgAiMemoryEventFromContainer({
    source: "other",
    harness: "cclg-e2e-smoke",
    org_id: undefined,
    user_id: undefined,
    company_bucket: "default",
    collection: "__schift_ai_daily_log",
    session_id: meta.session_id,
    job: { type: "smoke_test", title: "CCLG P2 local E2E smoke", status: "completed" },
    container: containerBytes,
  });

  // (i) Zero record loss: the container is preserved verbatim under
  // cclg.container_text, and patch_ids reflects every patch in the container
  // (not just the ones that survive the active projection).
  const containerTextVerbatim = event.cclg?.container_text === containerBytes.toString("utf8");
  check("(i) zero record loss: container_text preserved byte-for-byte verbatim", containerTextVerbatim);

  const patchIdsComplete = (event.cclg?.patch_ids?.length ?? 0) === meta.expected_container_patch_count;
  check(
    "(i) zero record loss: patch_ids count matches container's patch section (no patches dropped)",
    patchIdsComplete,
    `patch_ids=${event.cclg?.patch_ids?.length ?? 0} (want ${meta.expected_container_patch_count})`,
  );

  const countsComplete =
    event.cclg?.counts?.nodes === meta.expected_container_node_count &&
    event.cclg?.counts?.patches === meta.expected_container_patch_count;
  check(
    "(i) zero record loss: envelope cclg.counts mirrors container header counts",
    countsComplete,
    JSON.stringify(event.cclg?.counts),
  );

  // (ii) Search-friendly flat projection (node_ids / summary) must reflect
  // effectiveView(): only the active (non-superseded) fact survives.
  const activeCountMatches = (event.cclg?.node_ids?.length ?? 0) === meta.expected_active_node_count;
  check(
    "(ii) flat projection: node_ids count matches effectiveView active count",
    activeCountMatches,
    `node_ids=${event.cclg?.node_ids?.length ?? 0} (want ${meta.expected_active_node_count})`,
  );

  const supersededIdAbsent = !(event.cclg?.node_ids ?? []).includes(meta.revenue_fact_memory_id);
  check(
    "(ii) flat projection: superseded revenue-fact id is excluded from node_ids",
    supersededIdAbsent,
    `node_ids=${JSON.stringify(event.cclg?.node_ids)}`,
  );

  const activeIdPresent = (event.cclg?.node_ids ?? []).includes(meta.meeting_fact_memory_id);
  check(
    "(ii) flat projection: active meeting-fact id is present in node_ids",
    activeIdPresent,
    `node_ids=${JSON.stringify(event.cclg?.node_ids)}`,
  );

  const summary = event.cclg?.summary ?? "";
  const summaryHasActive = summary.includes(meta.active_substring_present);
  const summaryLacksSuperseded = !summary.includes(meta.superseded_substring_absent);
  check(
    "(ii) flat projection: summary contains the active (meeting) fact, not the superseded (revenue) one",
    summaryHasActive && summaryLacksSuperseded,
    `summary=${JSON.stringify(summary)}`,
  );

  // (iii) No auth/token material anywhere in the envelope. parseCclgContainer
  // already guards the container itself (guardAuthFree); this re-checks the
  // full envelope JSON (including the schift{} block, which legitimately
  // carries org_id/user_id/bucket/collection *labels*, not secrets) for any
  // actual credential-shaped field name.
  const FORBIDDEN_AUTH_KEYS = new Set(["api_key", "apikey", "access_token", "token", "authorization", "secret", "password"]);
  function scanForbidden(value: unknown, path: string, found: string[]): void {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => scanForbidden(entry, `${path}[${index}]`, found));
    } else if (value && typeof value === "object") {
      for (const [key, sub] of Object.entries(value as Record<string, unknown>)) {
        if (FORBIDDEN_AUTH_KEYS.has(key.toLowerCase())) found.push(`${path}.${key}`);
        scanForbidden(sub, `${path}.${key}`, found);
      }
    }
  }
  const authHits: string[] = [];
  scanForbidden(event, "event", authHits);
  check(
    "(iii) no auth/token fields anywhere in the envelope",
    authHits.length === 0,
    authHits.length ? `found: ${authHits.join(", ")}` : "clean",
  );

  const envelopeRoundTrips = (() => {
    try {
      JSON.stringify(event);
      return true;
    } catch {
      return false;
    }
  })();
  check("envelope JSON round-trips without throwing (this is what actually gets uploaded)", envelopeRoundTrips);

  finish();
}

function finish(): void {
  const failed = results.filter((r) => !r.pass);
  console.log("");
  console.log(`${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length > 0) {
    console.log("FAILED CHECKS:");
    for (const f of failed) console.log(`  - ${f.name}${f.detail ? ` (${f.detail})` : ""}`);
    process.exitCode = 1;
  } else {
    console.log("ALL PASS");
    process.exitCode = 0;
  }
}

main().catch((error) => {
  console.error("FAIL: unhandled error", error);
  process.exitCode = 1;
});
