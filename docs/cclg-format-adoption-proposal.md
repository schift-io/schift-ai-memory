# Proposal: Adopt CCLG as the Schift AI Memory Format

## Decision

Schift AI Memory should use CCLG as its canonical memory format/runtime.
Schift AI Memory remains the product wrapper for Schift users: install, auth,
redaction, queueing, upload, bucket routing, and hosted MCP retrieval.

```text
Schift AI Memory
        |
        | wraps and transports CCLG records/packs
        v
      CCLG

NOT:

Schift AI Memory
        |
        | defines a separate long-term memory model
        v
  competing schema
```

## Why

Both projects are Schift-owned, so maintaining two memory models would create
avoidable drift:

- CCLG already owns ledger structure, provenance, patches, suppression,
  conflict state, active packs, and code graph context.
- Schift AI Memory already owns the Schift-side distribution surface: npm
  install, OAuth/API key setup, local queue, upload, redaction, bucket scope, and
  MCP search/fetch.
- Keeping CCLG as the kernel lets Schift AI Memory add account and transport
  semantics without duplicating memory semantics.

## Target Architecture

```text
local coding agent
        |
        v
CCLG local runtime
  - raw evidence
  - MemoryNode / MemoryPatch / MemoryEdge
  - ActiveMemoryPack / CodeGraphPack
        |
        | export selected session / pack / node payload
        v
Schift AI Memory envelope
  - org_id / user_id
  - bucket / collection
  - upload policy / redaction policy
  - queue / upload status
        |
        v
Schift bucket document
        |
        v
hosted MCP search/fetch
```

The envelope is the product boundary. The payload is CCLG-shaped memory.

## Envelope Shape

```json
{
  "schema_version": "schift.ai_memory_envelope.v0.1",
  "kind": "cclg_session_summary",
  "schift": {
    "org_id": "org_...",
    "user_id": "usr_...",
    "bucket": "default",
    "collection": "__schift_ai_daily_log",
    "upload_policy": "summary_metadata_only",
    "redaction": "default"
  },
  "cclg": {
    "schema_version": "cclg.active_memory_pack.v0.1",
    "session_id": "session_...",
    "node_ids": ["mem_..."],
    "patch_ids": ["patch_..."],
    "source_labels": ["manual:quickstart"],
    "summary": "What the coding agent should retain from this session."
  }
}
```

## Migration From Current Event Model

Today, `AiMemoryEvent` is centered on job/event metadata:

```text
source / harness / event_kind
org_id / user_id / bucket / collection
job title / intent / status
summary / metadata
```

Target state:

```text
source / harness / event_kind
org_id / user_id / bucket / collection
job metadata as transport metadata
cclg payload as the memory body
```

The current event fields can stay for upload routing, dashboards, and filtering.
They should not become the long-term memory schema.

## Implementation Plan

1. Add a CCLG export command in the CCLG repo.

```text
cclg export schift --session <id>
cclg export schift --pack-query "<task>"
cclg export schift --node <mem_id>
```

The export must emit CCLG-shaped payloads with source provenance and no Schift
auth, bucket, or API fields.

2. Add CCLG envelope support in `@schift-io/ai-memory-core`.

```text
read CCLG export
  -> redact according to Schift AI Memory policy
  -> add Schift envelope
  -> enqueue locally or upload
```

3. Keep local-first boundaries intact.

```text
CCLG must not require SCHIFT_API_KEY.
CCLG must not write ~/.schift.
Schift AI Memory must not mutate ~/.cclg except through explicit import commands.
```

4. Make MCP retrieval expose CCLG metadata.

Search/fetch results should include embedded `cclg.schema_version`, node/session
references, and source labels when the uploaded document contains them.

5. Add optional import back into CCLG.

```text
Schift search result
  -> CCLG raw evidence import
  -> optional manual promotion to MemoryNode
```

Search results must not auto-promote into active CCLG memory.

## Acceptance Criteria

- Schift AI Memory can upload a CCLG session summary without inventing a separate
  memory shape.
- Uploaded Schift documents carry CCLG schema/version/provenance metadata.
- Existing summary/metadata upload still works as a compatibility path.
- CCLG remains usable without Schift auth or network.
- Tests cover CCLG payload to Schift envelope mapping.

## Non-Goals

- Do not make CCLG depend on Schift auth, buckets, API keys, or hosted services.
- Do not replace Schift bucket permissions with CCLG local state.
- Do not upload raw transcripts by default.
- Do not sync every local CCLG node automatically.
- Do not auto-promote Schift search results into active CCLG memory.
