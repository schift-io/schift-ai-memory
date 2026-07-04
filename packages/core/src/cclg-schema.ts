/**
 * Record-level validators (TS mirror of CCLG's `src/cclg/schema.py`).
 *
 * Ports `validate_node` / `validate_patch` / `validate_edge` / `validate_session`
 * verbatim (same required fields, same enums, same cross-reference checks
 * against `known_ids`/`known_patch_ids`) so a `.cclg` container loaded here is
 * held to the identical bar as CCLG's own `load_container`. `validate_active_pack`
 * is intentionally not ported: a `.cclg` container never carries an
 * `active_memory_pack` section (docs/CCLG_CONTAINER.md §3.1, "ledger-only").
 */
import { MEMORY_EDGE_SCHEMA, MEMORY_NODE_SCHEMA, MEMORY_PATCH_SCHEMA, SESSION_SCHEMA, type CclgRecord } from "./cclg-format.js";

export const NODE_STATUSES = new Set([
  "active",
  "pending",
  "superseded",
  "deprecated",
  "expired",
  "forgotten",
  "conflict_pending",
  "active_session",
  "pending_promotion",
  "promoted",
  "discarded",
]);

export const PATCH_OPERATIONS = new Set([
  "create",
  "update",
  "supersede",
  "refine",
  "expand",
  "narrow",
  "merge",
  "split",
  "expire",
  "deprecate",
  "forget",
  "resolve_conflict",
  "rollback",
]);

export const EDGE_TYPES = new Set([
  "supersedes",
  "refines",
  "expands",
  "narrows",
  "contradicts",
  "depends_on",
  "derived_from",
  "temporary_override",
  "source_of",
  "blocks",
  "resolves",
]);

export const NODE_TYPES = new Set([
  "preference",
  "identity_fact",
  "project_fact",
  "project_decision",
  "task",
  "commitment",
  "correction",
  "constraint",
  "tool_result",
  "artifact_reference",
  "code_state",
  "warning",
  "relationship",
  "temporal_event",
  "runbook",
  "benchmark_requirement",
  "security_policy",
  "memory",
]);

// Content-bearing patch operations: these require `new_content` and (per
// SUPERSEDING_OPERATIONS in cclg/patches.py) are also the operations that
// retire their old target(s) -- see cclg-effective-view.ts.
const CONTENT_PATCH_OPERATIONS = new Set([
  "create",
  "update",
  "supersede",
  "refine",
  "expand",
  "narrow",
  "merge",
  "split",
  "resolve_conflict",
]);

const REQUIRED_NODE_FIELDS = [
  "schema_version",
  "id",
  "type",
  "scope",
  "key",
  "content",
  "status",
  "confidence",
  "priority",
  "created_at",
  "updated_at",
  "effective_from",
  "effective_until",
  "source",
  "relations",
  "retrieval",
  "metadata",
];

const REQUIRED_PATCH_FIELDS = [
  "schema_version",
  "id",
  "operation",
  "target_ids",
  "new_node_ids",
  "reason",
  "source",
  "confidence",
  "resolution_policy",
  "created_at",
  "applied_at",
];

const REQUIRED_EDGE_FIELDS = ["schema_version", "id", "from", "to", "type", "created_at", "source_patch_id"];

const REQUIRED_SESSION_FIELDS = [
  "schema_version",
  "id",
  "agent",
  "workspace",
  "project",
  "started_at",
  "ended_at",
  "status",
  "parent_session_id",
  "branch_name",
  "loaded_memory_ids",
  "session_overlay_ids",
  "pending_patch_ids",
  "active_task",
  "policy",
  "events",
  "created_at",
  "updated_at",
];

function recordId(value: CclgRecord): string | undefined {
  return typeof value.id === "string" ? value.id : undefined;
}

function missingFields(kind: string, value: CclgRecord, required: string[]): string[] {
  return required.filter((field) => !(field in value)).map((field) => `${kind} ${recordId(value)}: missing ${field}`);
}

function isSourceGrounded(source: unknown): boolean {
  if (typeof source !== "object" || source === null) return false;
  const record = source as CclgRecord;
  if (record.label) return true;
  const rawSpans = record.raw_spans;
  return (
    Array.isArray(rawSpans) &&
    rawSpans.some((span) => typeof span === "object" && span !== null && Boolean((span as CclgRecord).source_id))
  );
}

export function validateNode(value: CclgRecord, knownIds?: Set<string>): string[] {
  const problems = missingFields("node", value, REQUIRED_NODE_FIELDS);
  const id = recordId(value);
  if (value.schema_version !== MEMORY_NODE_SCHEMA) {
    problems.push(`node ${id}: schema_version must be ${MEMORY_NODE_SCHEMA}`);
  }
  if (!(id ?? "").startsWith("mem_")) {
    problems.push(`node ${id}: id must start with mem_`);
  }
  if (!NODE_TYPES.has(value.type as string)) {
    problems.push(`node ${id}: unknown type ${String(value.type)}`);
  }
  const status = value.status as string | undefined;
  if (!NODE_STATUSES.has(status as string)) {
    problems.push(`node ${id}: unknown status ${String(status)}`);
  }
  if (!String(value.content ?? "").trim()) {
    problems.push(`node ${id}: content cannot be empty`);
  }
  if (!isSourceGrounded(value.source) && !["active_session", "pending", "pending_promotion"].includes(status ?? "")) {
    problems.push(`node ${id}: long-term node requires source label or source raw span`);
  }
  const relations = value.relations;
  if (typeof relations !== "object" || relations === null || Array.isArray(relations)) {
    problems.push(`node ${id}: relations must be object`);
  } else if (knownIds) {
    for (const [relation, nodeIds] of Object.entries(relations as CclgRecord)) {
      if (!Array.isArray(nodeIds)) {
        problems.push(`node ${id}: relations.${relation} must be list`);
        continue;
      }
      for (const nodeId of nodeIds) {
        if (!knownIds.has(nodeId)) problems.push(`node ${id}: relations.${relation} missing node ${nodeId}`);
      }
    }
  }
  return problems;
}

export function validatePatch(value: CclgRecord, knownIds?: Set<string>): string[] {
  const problems = missingFields("patch", value, REQUIRED_PATCH_FIELDS);
  const id = recordId(value);
  if (value.schema_version !== MEMORY_PATCH_SCHEMA) {
    problems.push(`patch ${id}: schema_version must be ${MEMORY_PATCH_SCHEMA}`);
  }
  if (!(id ?? "").startsWith("patch_")) {
    problems.push(`patch ${id}: id must start with patch_`);
  }
  const operation = value.operation as string | undefined;
  if (!operation || !PATCH_OPERATIONS.has(operation)) {
    problems.push(`patch ${id}: unknown operation ${String(operation)}`);
  }
  const targetIds = (value.target_ids as unknown[] | undefined) ?? [];
  if (operation !== "create" && targetIds.length === 0) {
    problems.push(`patch ${id}: target_ids required for ${operation}`);
  }
  if (operation && CONTENT_PATCH_OPERATIONS.has(operation) && !value.new_content) {
    problems.push(`patch ${id}: new_content required for ${operation}`);
  }
  if (knownIds) {
    for (const nodeId of targetIds as string[]) {
      if (!knownIds.has(nodeId)) problems.push(`patch ${id}: missing target node ${nodeId}`);
    }
    for (const nodeId of (value.new_node_ids as string[] | undefined) ?? []) {
      if (!knownIds.has(nodeId)) problems.push(`patch ${id}: missing new node ${nodeId}`);
    }
  }
  return problems;
}

export function validateEdge(value: CclgRecord, knownIds?: Set<string>, knownPatchIds?: Set<string>): string[] {
  const problems = missingFields("edge", value, REQUIRED_EDGE_FIELDS);
  const id = recordId(value);
  if (value.schema_version !== MEMORY_EDGE_SCHEMA) {
    problems.push(`edge ${id}: schema_version must be ${MEMORY_EDGE_SCHEMA}`);
  }
  if (!(id ?? "").startsWith("edge_")) {
    problems.push(`edge ${id}: id must start with edge_`);
  }
  if (!EDGE_TYPES.has(value.type as string)) {
    problems.push(`edge ${id}: unknown type ${String(value.type)}`);
  }
  if (knownIds) {
    if (!knownIds.has(value.from as string)) problems.push(`edge ${id}: missing from node ${String(value.from)}`);
    if (!knownIds.has(value.to as string)) problems.push(`edge ${id}: missing to node ${String(value.to)}`);
  }
  if (knownPatchIds && value.source_patch_id && !knownPatchIds.has(value.source_patch_id as string)) {
    problems.push(`edge ${id}: missing source patch ${String(value.source_patch_id)}`);
  }
  return problems;
}

export function validateSession(value: CclgRecord): string[] {
  const problems = missingFields("session", value, REQUIRED_SESSION_FIELDS);
  const id = recordId(value);
  if (value.schema_version !== SESSION_SCHEMA) {
    problems.push(`session ${id}: schema_version must be ${SESSION_SCHEMA}`);
  }
  if (!["active", "ended", "forked", "merged"].includes(value.status as string)) {
    problems.push(`session ${id}: unknown status ${String(value.status)}`);
  }
  return problems;
}
