/**
 * Effective-view projection over `.cclg` nodes/patches (TS mirror of CCLG's
 * `src/cclg/patches.py::effective_view` + its `_scope_rank` /
 * `_resolve_scope_precedence` helpers).
 *
 * This is a *read-time* projection, not a mutation: it never rewrites node
 * status, it only decides which already-loaded nodes are "currently active"
 * (docs/CCLG_CONTAINER.md §3.1 -- computing the effective view is explicitly a
 * read-time operation a loader performs after opening the container, the
 * container itself never carries a precomputed one).
 */
import type { CclgRecord } from "./cclg-format.js";

/**
 * Patch operations whose application retires the *old* target node(s) from
 * the active set -- `cclg/patches.py::SUPERSEDING_OPERATIONS` plus the
 * expire/forget/deprecate branch of `apply_patch`. "create" and "rollback" do
 * not retire their targets (mirrors `apply_patch`: `rollback` falls through to
 * the generic branch but is not in `SUPERSEDING_OPERATIONS`, so its target's
 * status is left `active`).
 */
const EXCLUDING_PATCH_OPERATIONS = new Set([
  "update",
  "supersede",
  "refine",
  "expand",
  "narrow",
  "merge",
  "split",
  "resolve_conflict",
  "expire",
  "forget",
  "deprecate",
]);

/**
 * The complete closed set of patch operations this reader's effective-view
 * logic has classified one way or the other: either retiring
 * (`EXCLUDING_PATCH_OPERATIONS`) or explicitly known-non-retiring ("create",
 * "rollback"). Mirrors `cclg/patches.py::KNOWN_PATCH_OPERATIONS` exactly.
 */
const KNOWN_PATCH_OPERATIONS = new Set([...EXCLUDING_PATCH_OPERATIONS, "create", "rollback"]);

/**
 * Raised by `effectiveView()` when a patch's `operation` is not in
 * `KNOWN_PATCH_OPERATIONS` (docs/CCLG_CONTAINER.md §3.1.1 fail-closed load
 * semantics; mirrors `cclg/patches.py::UnknownPatchOperationError`).
 *
 * An operation this reader doesn't recognize as retiring-or-not is not safe
 * to silently treat as non-retiring: a future container format version (or a
 * hand-edited/corrupted patch record) could carry an operation that *should*
 * retire its target, and computing an effective view that quietly ignores it
 * would resurrect a memory that was supposed to be superseded, expired,
 * forgotten, or deprecated. Fail-closed here, not fail-open.
 */
export class UnknownPatchOperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnknownPatchOperationError";
  }
}

function scopeOf(node: CclgRecord): CclgRecord {
  return (node.scope as CclgRecord | undefined) ?? {};
}

/** Effective-view scope precedence: session > project > workspace > global (`_scope_rank`). */
function scopeRank(node: CclgRecord, sessionId: string | undefined): number {
  const scope = scopeOf(node);
  if (node.status === "active_session" && scope.session === sessionId) return 4;
  if (scope.project) return 3;
  if (scope.workspace) return 2;
  return 1;
}

/**
 * Collapse keyed nodes so only the highest-precedence node per `key` survives;
 * nodes without a `key` are independent facts and are always kept
 * (`_resolve_scope_precedence`).
 */
function resolveScopePrecedence(nodes: CclgRecord[], sessionId: string | undefined): CclgRecord[] {
  const winners = new Map<string, CclgRecord>();
  const keyless: CclgRecord[] = [];
  for (const node of nodes) {
    const key = node.key as string | null | undefined;
    if (!key) {
      keyless.push(node);
      continue;
    }
    const current = winners.get(key);
    if (!current) {
      winners.set(key, node);
      continue;
    }
    const rank = scopeRank(node, sessionId);
    const currentRank = scopeRank(current, sessionId);
    const updatedAt = String(node.updated_at ?? "");
    const currentUpdatedAt = String(current.updated_at ?? "");
    if (rank > currentRank || (rank === currentRank && updatedAt > currentUpdatedAt)) {
      winners.set(key, node);
    }
  }
  return [...keyless, ...winners.values()];
}

/**
 * Pure effective-view projection over a node+patch list (TS mirror of
 * `cclg/patches.py::effective_view(nodes, session_id=...)`). Keeps `active`
 * nodes (+ this session's `active_session` overlay), drops
 * superseded/expired/forgotten/etc., then applies scope precedence.
 *
 * Difference from the Python function's signature: Python's `effective_view`
 * only takes `nodes`, because its `CCLGStore` always mutates a target node's
 * `status` via `apply_patch` *before* that node is ever packed into a
 * container -- so `node.status` alone is authoritative there. This port also
 * accepts `patches` directly and independently excludes any node referenced
 * as a `target_ids` entry of a patch whose operation retires its targets
 * (`EXCLUDING_PATCH_OPERATIONS` above), regardless of what the node's own
 * `status` field says. That's defense-in-depth for producers that don't
 * necessarily replay `apply_patch`'s status mutation before packing -- e.g.
 * per this repo's CLAUDE.md P3 note, agent-hub's export step converts a
 * "user corrected something" marker straight into a
 * `MemoryPatch(operation="supersede")` record.
 */
export function effectiveView(nodes: CclgRecord[], patches: CclgRecord[] = [], sessionId?: string): CclgRecord[] {
  const excludedIds = new Set<string>();
  for (const patch of patches) {
    const operation = patch.operation as string | undefined;
    if (!operation || !KNOWN_PATCH_OPERATIONS.has(operation)) {
      throw new UnknownPatchOperationError(
        `patch ${JSON.stringify(patch.id)} has unrecognized operation ${JSON.stringify(operation)}; ` +
          `refusing to compute effective view (docs/CCLG_CONTAINER.md §3.1.1 fail-closed load semantics) ` +
          `— known operations: ${[...KNOWN_PATCH_OPERATIONS].sort().join(", ")}`,
      );
    }
    if (EXCLUDING_PATCH_OPERATIONS.has(operation)) {
      for (const targetId of (patch.target_ids as string[] | undefined) ?? []) {
        excludedIds.add(targetId);
      }
    }
  }

  const candidates: CclgRecord[] = [];
  for (const node of nodes) {
    const id = node.id as string;
    if (excludedIds.has(id)) continue;
    if (node.status === "active") {
      candidates.push(node);
    } else if (sessionId && node.status === "active_session" && scopeOf(node).session === sessionId) {
      candidates.push(node);
    }
  }
  return resolveScopePrecedence(candidates, sessionId);
}
