# CodingAgent Default Role Package

Schift AI Memory ships a default role package for coding agents:

```text
schift.coding-agent.default
```

The role package is the unit that keeps install, tools, hooks, and security
aligned. It is not only an MCP server or only a hook bundle.

It includes:

- MCP retrieval tools: `search`, `fetch`, `schift_search`,
  `schift_memory_search`, `schift_list_buckets`,
  `schift_list_bucket_collections`
- lifecycle hooks: `codex-session-start`, `codex-stop`, `claude-stop`,
  `claude-session-end`
- the `schift-ai-memory` skill
- default routing to `bucket: default` and `collection: _daily_log`
- metadata-first upload policy with raw transcript capture off by default

The local credential source is:

```text
~/.schift/ai-memory/config.json
```

That file is created by:

```bash
npx -y schift-ai-memory login
```

The client includes identity/security metadata as provenance. Schift server
authorization remains authoritative and must enforce the API key scopes and
allowed bucket/collection access.

Required server-side scopes for the default package:

```text
ai_memory:read
ai_memory:write
buckets:read
buckets:upload
```

Workflow execution tools are intentionally disabled by default. They require an
explicit opt-in because they can mutate Schift workflow state:

```text
SCHIFT_AI_MEMORY_ENABLE_WORKFLOW_TOOLS=1
```
