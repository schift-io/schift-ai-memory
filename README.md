# Schift AI Memory

Installable AI work memory for Schift users.

- English: [README.en.md](README.en.md)
- Korean: [README.ko.md](README.ko.md)

## Quick Start

```bash
npx -y @schift-io/ai-memory init
```

This opens Schift in your browser, signs you in, creates a dedicated AI Memory
API key, verifies the key against Schift bucket access, caches returned
identity/security metadata locally, creates a Claude Code settings example, and
prints the remaining host-specific commands.

Local Schift config is stored under:

```text
~/.schift/ai-memory/config.json
```

Default routing:

```text
bucket: default
collection: __schift_ai_daily_log
```

## What You Get

- A local installer CLI for Codex, Claude Code, Claude Desktop, Cursor, and MCP.
- OAuth-based connection to your Schift account.
- A dedicated API key for AI memory upload, separate from your normal login.
- Cached `org_id`, `user_id`, and security metadata when Schift returns them at
  login. Hooks do not call `/me` on every session.
- A default CodingAgent role package that installs hooks, MCP retrieval tools,
  and security scope expectations together.
- Metadata-first daily work logs in Schift.
- MCP search/fetch reads from the same local login config, so users can retrieve
  what was uploaded without copying API keys into every MCP client.
- Conservative upload policy: summaries and metadata by default, raw transcripts off.
- Redaction for common secrets and local machine paths before upload.
- A reusable package boundary for plugin marketplace distribution.

## Different from Honcho

Honcho is an agent memory backend for persistent personalization and user/agent
modeling. Schift AI Memory is an installable harness for routing AI work logs,
daily summaries, and job metadata into a user's Schift company bucket.

In short:

- Honcho: agent memory and personalization backend.
- Schift AI Memory: company-owned AI work log ingestion for Schift.

See the full comparison:

- English: [How Is This Different from Honcho?](README.en.md#how-is-this-different-from-honcho)
- Korean: [Honcho와 뭐가 다른가](README.ko.md#honcho와-뭐가-다른가)

## Commands

```bash
npx -y @schift-io/ai-memory init
npx -y @schift-io/ai-memory init --print
npx -y @schift-io/ai-memory login
npx -y @schift-io/ai-memory install            # every harness found on this host
npx -y @schift-io/ai-memory install --dry-run  # show targets, write nothing
npx -y @schift-io/ai-memory uninstall          # remove only Schift-owned hooks
npx -y @schift-io/ai-memory doctor --search
npx -y @schift-io/ai-memory flush              # send whatever the hooks queued
npx -y @schift-io/ai-memory codex-marketplace
npx -y @schift-io/ai-memory metadata-example
```

`install` detects the harnesses actually present (Claude Code, Codex, …) and
writes hooks into each one's own config file. Nothing is written for a harness
that is not installed, existing non-Schift hooks are preserved, and re-running
is idempotent. `claude-code-settings` still works as an alias.

Hooks send a little of the backlog on every run; `flush` empties it and is what
a scheduled job should call. Events that can never succeed (revoked key,
malformed payload) move to `queue/quarantine` rather than being dropped, and
`flush` exits 2 when that happens.

Scoped package form also works:

```bash
npx -y --package @schift-io/ai-memory schift-ai-memory login
```

## Packages

- `schift-ai-memory`: npx-friendly installer CLI
- `@schift-io/ai-memory`: scoped installer CLI
- `@schift-io/ai-memory-core`: shared metadata, redaction, queue, and upload helpers
- `@schift-io/ai-memory-hooks`: lifecycle hook commands for Codex and Claude
- `@schift-io/ai-memory-mcp`: MCP server package

## Role Package

The default CodingAgent package is `schift.coding-agent.default`.
It is the one-shot bundle for coding agents: MCP `search`/`fetch`, Schift
memory search tools, lifecycle hooks, and metadata-first security defaults.
See [docs/coding-agent-role-package.md](docs/coding-agent-role-package.md).
Server-side scope enforcement is specified in
[docs/server-scope-enforcement.md](docs/server-scope-enforcement.md).

## Format Direction

Schift AI Memory should adopt CCLG as its canonical memory format/runtime and
wrap it with Schift auth, bucket, redaction, queue, and upload metadata. See
[docs/cclg-format-adoption-proposal.md](docs/cclg-format-adoption-proposal.md).

## Repository Layout

```text
packages/cli      npx installer and config writer
packages/core     metadata schema, redaction, local queue, uploader
packages/hooks    Codex/Claude lifecycle hook commands
packages/mcp      Schift MCP server
packages/npx      unscoped npx package
plugins/          Codex plugin marketplace bundle
bundles/          Claude Desktop MCPB manifest template
docs/             boundary, privacy, and host-specific installation notes
```

## Development

```bash
npm install
npm run build
npm run lint
npm test
npm audit --audit-level=high
```
