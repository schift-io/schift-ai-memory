/**
 * `.cclg` format/container constants (TS mirror of CCLG's `src/cclg/format.py`).
 *
 * Canonical source: https://github.com/schift-io/CCLG `src/cclg/format.py` +
 * `docs/CCLG_CONTAINER.md` (normative spec). Only the subset this package's
 * container loader + effective-view projection actually needs is ported here
 * -- e.g. no `ACTIVE_MEMORY_PACK_SCHEMA`/`CODE_GRAPH_SCHEMA`/TOML helpers,
 * since a `.cclg` container is ledger-only (docs/CCLG_CONTAINER.md §3.1) and
 * never carries those.
 */

/** Generic JSON-object record shape: a node/patch/edge/session dict, or the header. */
export type CclgRecord = Record<string, unknown>;

export const CCLG_CONTAINER_MAGIC = "CCLG";
export const CCLG_CONTAINER_VERSION = "0.1";
export const CCLG_CONTAINER_ID = `cclg.container.v${CCLG_CONTAINER_VERSION}`;

export const CCLG_FORMAT_VERSION = "0.1";
export const CCLG_FORMAT_ID = "cclg.format.v0.1";

export const MEMORY_NODE_SCHEMA = "cclg.memory_node.v0.1";
export const MEMORY_PATCH_SCHEMA = "cclg.memory_patch.v0.1";
export const MEMORY_EDGE_SCHEMA = "cclg.edge.v0.1";
export const SESSION_SCHEMA = "cclg.session.v0.1";

/**
 * Fixed on-disk section order (docs/CCLG_CONTAINER.md §2.3, mirrors
 * `container.py::SECTION_ORDER`). Adding a new *known* section is a breaking
 * container-version bump, not an addition to this tuple -- unknown sections
 * are handled separately as a forward-compat passthrough (§7).
 */
export const CCLG_SECTION_ORDER = ["nodes", "patches", "edges", "sessions"] as const;
export type CclgSectionName = (typeof CCLG_SECTION_ORDER)[number];
