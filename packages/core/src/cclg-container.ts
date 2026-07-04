/**
 * `.cclg` portable container reader (TS mirror of CCLG's `src/cclg/container.py`
 * `load_container`; normative spec: docs/CCLG_CONTAINER.md in the CCLG repo).
 *
 * This is a *reader only* -- there is no `packCclgContainer` here. Producing
 * `.cclg` containers stays the job of the CCLG Python package / whatever
 * upstream producer writes them (e.g. agent-hub's export step, per the P3
 * container-producer note in this repo's CLAUDE.md); this module's job is to
 * load one losslessly so a JS/TS consumer never has to degrade it to tags.
 */
import { createHash } from "node:crypto";
import {
  CCLG_CONTAINER_ID,
  CCLG_CONTAINER_MAGIC,
  CCLG_CONTAINER_VERSION,
  CCLG_FORMAT_ID,
  CCLG_SECTION_ORDER,
  type CclgRecord,
} from "./cclg-format.js";
import { validateEdge, validateNode, validatePatch, validateSession } from "./cclg-schema.js";

// Schift platform-auth fields that must never appear in a container, at any
// nesting depth, in header or records (docs/CCLG_CONTAINER.md §3.2). Kept
// deliberately narrow: CCLG's own local scope model legitimately uses bare
// "user"/"org" keys (MemoryNode.scope) which are not platform credentials and
// must not be flagged.
const FORBIDDEN_AUTH_KEYS = new Set(["org_id", "user_id", "bucket", "collection", "api_key", "apikey", "token", "access_token"]);

export class ContainerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerError";
  }
}

export interface ContainerBundle {
  header: CclgRecord;
  nodes: CclgRecord[];
  patches: CclgRecord[];
  edges: CclgRecord[];
  sessions: CclgRecord[];
  /** Section marker names not in CCLG_SECTION_ORDER, kept verbatim (docs/CCLG_CONTAINER.md §7). */
  unknownSections: Record<string, CclgRecord[]>;
  /** Non-fatal issues found while loading: format_id mismatch, unknown sections. */
  warnings: string[];
  counts: { nodes: number; patches: number; edges: number; sessions: number };
}

export interface ParseCclgContainerOptions {
  /** Re-validate every record against the schema.ts validators (default true, matching Python's `load_container(..., validate=True)`). */
  validate?: boolean;
}

function scanForbiddenKeys(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) scanForbiddenKeys(item, found);
  } else if (value && typeof value === "object") {
    for (const [key, sub] of Object.entries(value as CclgRecord)) {
      if (FORBIDDEN_AUTH_KEYS.has(key.toLowerCase())) found.add(key);
      scanForbiddenKeys(sub, found);
    }
  }
  return found;
}

function guardAuthFree(value: CclgRecord, ref: string): void {
  const found = scanForbiddenKeys(value);
  if (found.size > 0) {
    throw new ContainerError(`${ref}: forbidden auth field(s) present (container must be auth-free): ${[...found].sort().join(", ")}`);
  }
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Parse, structurally verify, and (by default) schema-validate a `.cclg`
 * container's raw bytes.
 *
 * Throws `ContainerError` on: bad magic, unsupported container version,
 * malformed header, a section present in the body missing its
 * `counts`/`sections` header entry (docs/CCLG_CONTAINER.md §5), checksum
 * mismatch, an auth field anywhere in header or records, or (when
 * `validate: true`, the default) any record failing schema.ts's validators.
 * Unknown sections are not an error: they are collected into
 * `unknownSections` with a warning (§7), and a `header.format_id` mismatch is
 * likewise a warning, not a hard failure (§4).
 */
export function parseCclgContainer(data: Uint8Array | Buffer, options: ParseCclgContainerOptions = {}): ContainerBundle {
  const { validate = true } = options;
  const text = Buffer.from(data).toString("utf8");

  // Literal "\n" splitting, not a locale/unicode-linebreak-aware split -- see
  // docs/CCLG_CONTAINER.md §6 for why the container spec insists on this
  // distinction (it's what keeps the checksum domain byte-exact).
  let rawLines = text.split("\n");
  if (rawLines.length > 0 && rawLines[rawLines.length - 1] === "") {
    rawLines = rawLines.slice(0, -1);
  }
  if (rawLines.length === 0) {
    throw new ContainerError("empty container: missing magic line");
  }

  const magicLine = rawLines[0];
  const tabIndex = magicLine.indexOf("\t");
  if (tabIndex === -1) {
    throw new ContainerError(`malformed magic line (expected 'MAGIC<TAB>VERSION'): ${JSON.stringify(magicLine)}`);
  }
  // Split on the *first* tab only (mirrors Python's `split("\t", 1)`; JS's
  // `String.split(sep, limit)` truncates the result array instead, which is
  // not the same thing, hence the manual indexOf/slice here).
  const magic = magicLine.slice(0, tabIndex);
  const containerVersion = magicLine.slice(tabIndex + 1);
  if (magic !== CCLG_CONTAINER_MAGIC) {
    throw new ContainerError(`bad magic: expected ${JSON.stringify(CCLG_CONTAINER_MAGIC)}, got ${JSON.stringify(magic)}`);
  }
  if (containerVersion !== CCLG_CONTAINER_VERSION) {
    throw new ContainerError(
      `unsupported container version ${JSON.stringify(containerVersion)}: this reader only implements ` +
        `${JSON.stringify(CCLG_CONTAINER_VERSION)} (0.x minor bumps are breaking, per docs/CCLG_CONTAINER.md §1)`,
    );
  }
  if (rawLines.length < 2) {
    throw new ContainerError("container missing header line");
  }

  let header: unknown;
  try {
    header = JSON.parse(rawLines[1]);
  } catch (error) {
    throw new ContainerError(`invalid header JSON: ${(error as Error).message}`);
  }
  if (typeof header !== "object" || header === null || Array.isArray(header)) {
    throw new ContainerError("header line must be a JSON object");
  }
  const headerRecord = header as CclgRecord;
  if (headerRecord.container !== CCLG_CONTAINER_ID) {
    throw new ContainerError(`unsupported container id ${JSON.stringify(headerRecord.container)}, expected ${JSON.stringify(CCLG_CONTAINER_ID)}`);
  }
  for (const requiredKey of ["format_id", "versions", "sections", "counts", "generated_at", "content_sha256"]) {
    if (!(requiredKey in headerRecord)) {
      throw new ContainerError(`header missing required key: ${requiredKey}`);
    }
  }

  const bodyLines = rawLines.slice(2);
  const sections: Record<string, CclgRecord[]> = {};
  const sectionOrderSeen: string[] = [];
  let current: string | null = null;
  for (const line of bodyLines) {
    if (line === "") continue;
    if (line.startsWith("@")) {
      current = line.slice(1).trim();
      if (!(current in sections)) {
        sections[current] = [];
        sectionOrderSeen.push(current);
      }
      continue;
    }
    if (current === null) {
      throw new ContainerError(`record line before any '@section' marker: ${JSON.stringify(line)}`);
    }
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch (error) {
      throw new ContainerError(`invalid record JSON under @${current}: ${(error as Error).message}`);
    }
    if (typeof record !== "object" || record === null || Array.isArray(record)) {
      throw new ContainerError(`record under @${current} must be a JSON object`);
    }
    sections[current].push(record as CclgRecord);
  }

  // Integrity check before anything else is trusted (docs/CCLG_CONTAINER.md §6).
  const recomputedSha256 = sha256Hex(bodyLines.join("\n"));
  const expectedSha256 = headerRecord.content_sha256;
  if (expectedSha256 !== recomputedSha256) {
    throw new ContainerError(`checksum mismatch: header content_sha256=${JSON.stringify(expectedSha256)}, recomputed=${JSON.stringify(recomputedSha256)}`);
  }

  const headerCounts = (headerRecord.counts as CclgRecord) ?? {};
  const headerSectionCounts: Record<string, number> = {};
  for (const entry of (headerRecord.sections as CclgRecord[] | undefined) ?? []) {
    if (entry && typeof entry.name === "string") headerSectionCounts[entry.name] = entry.count as number;
  }
  for (const name of CCLG_SECTION_ORDER) {
    const actual = (sections[name] ?? []).length;
    const sectionPresent = name in sections;
    // A section actually present in the body (its "@name" marker was seen,
    // even with zero records under it) MUST be redundantly described by
    // *both* header.counts and header.sections (docs/CCLG_CONTAINER.md §5). A
    // missing entry for a present section is exactly the truncated/hand-edited
    // case §5 exists to catch, so it's a hard error, not "nothing to compare".
    for (const [sourceName, sourceCounts] of [
      ["counts", headerCounts] as const,
      ["sections", headerSectionCounts] as const,
    ]) {
      if (!(name in sourceCounts)) {
        if (sectionPresent) {
          throw new ContainerError(`count mismatch for '${name}': header.${sourceName} has no entry for it, but body has ${actual} record(s) under '@${name}'`);
        }
        continue;
      }
      const expected = (sourceCounts as CclgRecord)[name];
      if (expected !== actual) {
        throw new ContainerError(`count mismatch for '${name}': header.${sourceName} says ${expected}, body has ${actual}`);
      }
    }
  }

  const warnings: string[] = [];
  if (headerRecord.format_id !== CCLG_FORMAT_ID) {
    // §4: informational cross-check only -- warn, don't hard-fail. The
    // authoritative check is each record's own schema_version, re-validated
    // per-record below regardless of what this header field claims.
    warnings.push(
      `format_id mismatch: header declares ${JSON.stringify(headerRecord.format_id)}, this reader implements ` +
        `${JSON.stringify(CCLG_FORMAT_ID)} — continuing per docs/CCLG_CONTAINER.md §4 (record-level schema_version is the authoritative check)`,
    );
  }
  const unknownSections: Record<string, CclgRecord[]> = {};
  const knownSectionNames: readonly string[] = CCLG_SECTION_ORDER;
  for (const name of sectionOrderSeen) {
    if (!knownSectionNames.includes(name)) {
      unknownSections[name] = sections[name];
      warnings.push(`unknown section '@${name}' skipped (${sections[name].length} record(s)) — forward-compat passthrough`);
    }
  }

  const bundle: ContainerBundle = {
    header: headerRecord,
    nodes: sections.nodes ?? [],
    patches: sections.patches ?? [],
    edges: sections.edges ?? [],
    sessions: sections.sessions ?? [],
    unknownSections,
    warnings,
    counts: {
      nodes: (sections.nodes ?? []).length,
      patches: (sections.patches ?? []).length,
      edges: (sections.edges ?? []).length,
      sessions: (sections.sessions ?? []).length,
    },
  };

  guardAuthFree(headerRecord, "header");
  for (const name of CCLG_SECTION_ORDER) {
    for (const record of bundle[name]) {
      guardAuthFree(record, `${name}:${record.id as string | undefined}`);
    }
  }

  if (validate) {
    const knownIds = new Set(bundle.nodes.map((record) => record.id as string));
    const knownPatchIds = new Set(bundle.patches.map((record) => record.id as string));
    const problems: string[] = [];
    for (const record of bundle.nodes) problems.push(...validateNode(record, knownIds));
    for (const record of bundle.patches) problems.push(...validatePatch(record, knownIds));
    for (const record of bundle.edges) problems.push(...validateEdge(record, knownIds, knownPatchIds));
    for (const record of bundle.sessions) problems.push(...validateSession(record));
    if (problems.length > 0) {
      throw new ContainerError(`invalid records: ${problems.join("; ")}`);
    }
  }

  return bundle;
}
