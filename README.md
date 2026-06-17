# Schift AI Memory

User-installed collector for saving AI work context into the right Schift
company memory bucket.

The product is distributed as installable pieces:

- `npx @schift-io/ai-memory init` for setup
- `@schift-io/ai-memory-mcp` for local or hosted MCP
- Codex plugin bundle with skills, MCP config, and opt-in hooks
- Claude Code hook installer
- Claude Desktop `.mcpb` bundle template

## Install

```bash
npx @schift-io/ai-memory init
```

Recommended first connection:

```bash
npx @schift-io/ai-memory login
```

The CLI opens Schift OAuth in the browser, receives a local callback, stores a
dedicated AI Memory API key, and verifies it with `/v1/auth/me`.

The installer asks which harnesses to configure:

- Codex plugin
- Claude Code hooks
- Claude Desktop MCP bundle
- Cursor MCP config

Default upload policy is summaries and metadata only. Raw transcripts and
artifact upload must be explicitly enabled.

Default routing:

```text
bucket: default
collection: _daily_log
```

## Repository Layout

```text
packages/cli      npx installer and config writer
packages/core     metadata schema, redaction, local queue, uploader
packages/hooks    Codex/Claude lifecycle hook commands
packages/mcp      Schift MCP server, seeded from @schift-io/mcp
plugins/          Codex plugin marketplace bundle
bundles/          Claude Desktop MCPB manifest template
```

## Metadata Shape

Every event is routed to a Schift company bucket with job metadata:

```json
{
  "source": "codex",
  "harness": "codex-plugin",
  "event_kind": "ai_job_summary",
  "company_bucket": "company:...",
  "job": {
    "type": "coding",
    "title": "Implement billing smoke test",
    "intent": "what the user was trying to accomplish",
    "status": "completed",
    "repo": "schift-io/schift",
    "branch": "main",
    "commit": "abc123"
  },
  "content_policy": {
    "raw_transcript": false,
    "artifacts": "selected",
    "redaction": "default"
  }
}
```

## Local Development

```bash
npm install
npm run build
npm test
```

## Publish Surfaces

```bash
npm publish --workspace @schift-io/ai-memory --access public
npm publish --workspace @schift-io/ai-memory-core --access public
npm publish --workspace @schift-io/ai-memory-hooks --access public
npm publish --workspace @schift-io/ai-memory-mcp --access public
```

Codex plugin distribution is exposed through:

```bash
codex plugin marketplace add schift-io/schift-ai-memory --sparse .agents/plugins
```

Claude Desktop `.mcpb` release assets are built from `bundles/claude-desktop/`.
