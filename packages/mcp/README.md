# @schift-io/ai-memory-mcp

MCP server component for Schift AI Memory.

It lets MCP clients search and fetch Schift memory while the broader
`@schift-io/ai-memory` installer handles harness setup, hooks, and plugin
configuration.

## Install

```bash
npm install -g @schift-io/ai-memory-mcp
```

Or run without a global install:

```bash
SCHIFT_API_KEY=sk-... npx -y @schift-io/ai-memory-mcp
```

## Hosted Remote MCP

Where supported, prefer the hosted Schift MCP endpoint:

```text
https://mcp.schift.io/mcp
Authorization: Bearer <your-schift-api-key-or-oauth-token>
```

## Local MCP Config

```json
{
  "mcpServers": {
    "schift-ai-memory": {
      "command": "npx",
      "args": ["-y", "@schift-io/ai-memory-mcp"],
      "env": {
        "SCHIFT_API_KEY": "sk-...",
        "SCHIFT_DEFAULT_BUCKET": "company:default"
      }
    }
  }
}
```

## Tools

Default tools:

- `search`
- `fetch`
- `schift_search`
- `schift_list_buckets`
- `schift_list_bucket_collections`
- `schift_upload_document`
- `schift_memory_search`
- `schift_memory_list_sources`

Workflow execution tools are disabled by default because Schift AI Memory is a
collector/search component, not an Agent Hub runtime. Enable them only for
intentional advanced use:

```bash
SCHIFT_AI_MEMORY_ENABLE_WORKFLOW_TOOLS=1 npx -y @schift-io/ai-memory-mcp
```

## HTTP Mode

```bash
SCHIFT_MCP_AUTH_MODE=upstream-bearer \
schift-ai-memory-mcp --http
```

For local static-token testing:

```bash
SCHIFT_API_KEY=sk-... \
SCHIFT_MCP_BEARER_TOKEN=local-token \
schift-ai-memory-mcp --http
```

## Smoke Test

```bash
SCHIFT_MCP_URL=https://mcp.example.com/mcp \
SCHIFT_TOKEN_A=sk-or-oauth-user-a \
SCHIFT_TOKEN_B=sk-or-oauth-user-b \
SCHIFT_MCP_SMOKE_QUERY="acme renewal" \
npm run smoke:memory --workspace @schift-io/ai-memory-mcp
```
