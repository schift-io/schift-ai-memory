# Schift AI Memory

Installable AI work memory for Schift users.

- English: [README.en.md](README.en.md)
- Korean: [README.ko.md](README.ko.md)

## Quick Start

```bash
npx -y schift-ai-memory login
```

This opens Schift in your browser, signs you in, creates a dedicated AI Memory
API key, verifies it with `/v1/auth/me`, and stores local configuration under:

```text
~/.schift/ai-memory/config.json
```

Default routing:

```text
bucket: default
collection: _daily_log
```

## What You Get

- A local installer CLI for Codex, Claude Code, Claude Desktop, Cursor, and MCP.
- OAuth-based connection to your Schift account.
- A dedicated API key for AI memory upload, separate from your normal login.
- Metadata-first daily work logs in Schift.
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
npx -y schift-ai-memory login
npx -y schift-ai-memory init
npx -y schift-ai-memory codex-marketplace
npx -y schift-ai-memory claude-code-settings --print
npx -y schift-ai-memory metadata-example
```

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
