#!/usr/bin/env python3
"""Local E2E smoke fixture generator: agent-hub memory -> `.cclg` container bytes.

Producer half of the CCLG TODO P2 "Local end-to-end smoke" item. Exercises the
*real* production path end to end:

  InMemoryAgentHubStore.append_memory (source_document facts)
  -> InMemoryAgentHubStore.append_system_memory (supersession marker, same
     call shape agent_hub.cclg_grounding._apply_cclg_corrections actually uses)
  -> InMemoryAgentHubStore.list_memory
  -> agent_hub.memory_export.export_session_cclg

...and writes the resulting `.cclg` container bytes to
scripts/fixtures/smoke.cclg, plus a sidecar scripts/fixtures/smoke.meta.json
recording the memory ids and expected substrings so the TS consumer-side smoke
(cclg-envelope-smoke.ts) doesn't have to hardcode fragile assumptions about
node ordering or ids.

Run with the agent-hub venv (cclg is editable-installed there):

    services/agent-hub/.venv/bin/python \
        derivatives/schift-ai-memory/scripts/cclg-smoke-fixture.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
AGENT_HUB_SRC = REPO_ROOT / "services" / "agent-hub" / "src"
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"

if str(AGENT_HUB_SRC) not in sys.path:
    sys.path.insert(0, str(AGENT_HUB_SRC))


def fail(message: str) -> None:
    print(f"FAIL: {message}")
    sys.exit(1)


def main() -> None:
    try:
        from agent_hub.memory_export import export_session_cclg
        from agent_hub.models import MemoryAppendRequest, MemoryKind
        from agent_hub.store import InMemoryAgentHubStore
    except ImportError as exc:
        fail(f"agent-hub / cclg import failed -- run with services/agent-hub/.venv python: {exc}")
        return

    tenant_id, agent_id, user_id, conversation_id = (
        "acct_cclgsmoke",
        "cclg-smoke",
        "user_cclgsmoke",
        "conv_cclgsmoke",
    )
    session_id = f"{tenant_id}:{agent_id}:{user_id}:{conversation_id}"

    store = InMemoryAgentHubStore()

    def append_fact(label: str, text: str):
        return store.append_memory(
            session_id,
            MemoryAppendRequest(
                tenant_id=tenant_id,
                agent_id=agent_id,
                user_id=user_id,
                conversation_id=conversation_id,
                role="system",
                content_redacted=f"source_document:{label}: {text}",
                kind=MemoryKind.FACT,
            ),
        )

    revenue_fact = append_fact("revenue", "작년 매출은 5억원이었다")
    meeting_fact = append_fact("schedule", "정기 회의는 매주 화요일 10시")

    # Real production shape: agent_hub.cclg_grounding._apply_cclg_corrections
    # calls hub_store.append_system_memory(session_id, title="cclg_supersede",
    # content_redacted=f"cclg:supersede:{ids}", kind="fact",
    # tags=["memory:cclg-supersede", "source:cclg"]) -- mirrored verbatim here
    # instead of hand-building a MemoryItem so this smoke actually exercises
    # the same call shape the correction hook uses.
    store.append_system_memory(
        session_id,
        title="cclg_supersede",
        content_redacted=f"cclg:supersede:{revenue_fact.memory_id}",
        kind="fact",
        tags=["memory:cclg-supersede", "source:cclg"],
    )

    memories = store.list_memory(session_id)
    if len(memories) != 3:
        fail(f"expected 3 memories (2 facts + 1 marker) in session, got {len(memories)}")
        return

    container_bytes = export_session_cclg(session_id, memories)
    if container_bytes is None:
        fail("export_session_cclg returned None -- cclg not installed or packing failed (see agent_hub.memory_export debug logs)")
        return

    FIXTURES_DIR.mkdir(parents=True, exist_ok=True)
    fixture_path = FIXTURES_DIR / "smoke.cclg"
    fixture_path.write_bytes(container_bytes)

    meta = {
        "session_id": session_id,
        "revenue_fact_memory_id": revenue_fact.memory_id,
        "meeting_fact_memory_id": meeting_fact.memory_id,
        "memories_appended_count": len(memories),  # 2 facts + 1 marker
        "active_substring_present": "정기 회의는 매주 화요일 10시",
        "superseded_substring_absent": "5억원",
        # Container-level expectations (marker never becomes a node -- it is
        # converted to a MemoryPatch, per memory_export._marker_to_patch).
        "expected_container_node_count": 2,
        "expected_container_patch_count": 1,
        # effectiveView() projection: only the meeting fact is active, the
        # revenue fact is excluded (status="superseded" + patch target_ids).
        "expected_active_node_count": 1,
    }
    meta_path = FIXTURES_DIR / "smoke.meta.json"
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(f"PASS: wrote {len(container_bytes)} bytes to {fixture_path}")
    print(f"PASS: wrote meta to {meta_path}")
    print(json.dumps(meta, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
