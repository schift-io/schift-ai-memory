# Schift AI Memory

Schift AI Memory lets a user save useful AI work context from Codex, Claude,
Cursor, and MCP tools into the user's Schift company memory.

The default destination is:

```text
bucket: default
collection: __schift_ai_daily_log
```

The default policy is conservative: upload summaries and metadata first. Raw
transcripts and artifacts are not uploaded unless explicitly enabled by the
host configuration.

## What You Get

After installation, the user gets:

- A `schift-ai-memory` CLI that can be run with `npx`.
- Browser OAuth login to Schift.
- A dedicated AI Memory API key stored locally at
  `~/.schift/ai-memory/config.json`.
- API key verification against Schift bucket access before the connector is
  treated as connected.
- Cached `org_id`, `user_id`, and security metadata when the Schift OAuth code
  exchange returns them. Hooks reuse this local cache instead of calling `/me`
  on every AI session.
- Daily AI work records routed to `bucket: default` and
  `collection: __schift_ai_daily_log`. If a Schift bucket collection named `__schift_ai_daily_log`
  exists, uploads attach its `collection_id`; otherwise `__schift_ai_daily_log` is stored
  as document metadata.
- Job metadata for each AI session: source, harness, job type, title, intent,
  status, repository, branch, and content policy.
- Redaction of common secrets and strict local machine paths before upload.
- Install surfaces for Codex plugins, Claude Code hooks, Claude Desktop MCP,
  Cursor MCP, and direct MCP usage.
- Retrieval through MCP: `search`, `fetch`, `schift_search`, and
  `schift_memory_search` can read the same Schift bucket after login.
- A default CodingAgent role package that installs retrieval tools, lifecycle
  hooks, and Schift security scope expectations as one unit.

## How Is This Different from Honcho?

Honcho is a memory backend for building stateful agents. It focuses on
persistent personalization, user and agent modeling, and reasoning over
people, agents, groups, projects, and ideas over time. Its hosted MCP server is
designed to give AI tools persistent memory and personalization.

Schift AI Memory is narrower and more operational:

- Schift AI Memory is an installable harness for capturing AI work logs into a
  user's own Schift company bucket.
- The system of record is Schift: `bucket: default`,
  `collection: __schift_ai_daily_log`, user security metadata, and company-scoped memory.
- The primary record is a job/event: what work was done, why it was done, by
  which harness, in which repo or project, and with what content policy.
- It is metadata-first by default. Raw transcript capture is opt-in.
- It is meant to package Codex hooks, Claude hooks, MCP, and plugin
  marketplace distribution around Schift's existing bucket and auth model.

Use Honcho when you want an agent memory backend that models users and agents
over time. Use Schift AI Memory when you want your team's AI work history,
daily logs, and job metadata to land in Schift under your company's bucket and
security boundary.

References:

- Honcho repository: <https://github.com/plastic-labs/honcho>
- Honcho MCP docs: <https://honcho.dev/docs/v3/guides/integrations/mcp>

## Install

Recommended:

```bash
npx -y @schift-io/ai-memory init
```

This command:

1. Starts a local callback server.
2. Opens Schift OAuth in your browser.
3. Lets you sign in and approve AI Memory access.
4. Receives the callback and exchanges it for a dedicated API key.
5. Verifies the API key against Schift bucket access.
6. Caches returned `org_id`, `user_id`, security metadata, and a refresh window
   in `~/.schift/ai-memory/config.json`.
7. Writes a Claude Code settings example to
   `~/.claude/settings.schift-ai-memory.example.json`.
8. Prints the Codex plugin and MCP commands that still need to be installed by
   the host tool.

Use a custom route only when needed:

```bash
npx -y @schift-io/ai-memory init --bucket default --collection __schift_ai_daily_log
```

The scoped package form also works:

```bash
npx -y --package @schift-io/ai-memory schift-ai-memory init
```

If you only want to connect OAuth without writing host settings:

```bash
npx -y @schift-io/ai-memory login
```

Check the installed credential, bucket access, collection routing, and role
package:

```bash
npx -y @schift-io/ai-memory doctor --search
```

## Preview the Install Plan

```bash
npx -y @schift-io/ai-memory init --print
```

This prints the Codex, Claude, Claude Desktop, Cursor, and MCP configuration
plan without opening OAuth or writing files.

## Codex

Print the Codex marketplace command:

```bash
npx -y @schift-io/ai-memory codex-marketplace
```

Current output:

```bash
codex plugin marketplace add schift-io/schift-ai-memory --sparse .agents/plugins
```

The plugin bundle contains:

- the default `schift.coding-agent.default` role package
- MCP configuration
- lifecycle hook configuration
- a Schift AI Memory skill
- metadata and upload defaults

## Claude Code

Print Claude Code hook settings:

```bash
npx -y @schift-io/ai-memory claude-code-settings --print
```

Write an example settings file:

```bash
npx -y @schift-io/ai-memory claude-code-settings
```

The generated file is:

```text
~/.claude/settings.schift-ai-memory.example.json
```

Review it and merge it into `~/.claude/settings.json` when ready.

## Claude Desktop and Cursor MCP

Use the MCP package:

```bash
npx -y @schift-io/ai-memory-mcp
```

Minimum MCP environment:

```text
SCHIFT_DEFAULT_BUCKET=default
SCHIFT_COLLECTION=__schift_ai_daily_log
```

After `schift-ai-memory login` or `schift-ai-memory init`, the MCP package reads
`~/.schift/ai-memory/config.json` by default, so `SCHIFT_API_KEY` does not need
to be duplicated into each local MCP client config. Explicit MCP env values
still override the local login config. `schift-ai-memory init --print` prints a
Cursor-compatible MCP config block.

Codex and Claude hooks read `~/.schift/ai-memory/config.json`. When the config
contains an API key, hooks upload by default and use the local queue as a
fallback. If Schift returns `401` or `403`, the hook preserves the API key but
marks the config as `revoked_or_invalid` and records `last_upload_error` so the
user can reconnect. Set `SCHIFT_AI_MEMORY_UPLOAD=0` to force queue-only mode.

## What Gets Uploaded

A typical event looks like this:

```bash
npx -y @schift-io/ai-memory metadata-example
```

Example shape:

```json
{
  "source": "codex",
  "harness": "codex-plugin",
  "company_bucket": "default",
  "collection": "__schift_ai_daily_log",
  "event_kind": "ai_job_summary",
  "job": {
    "type": "coding",
    "title": "Implement AI memory collector",
    "intent": "Capture user AI work as company memory",
    "status": "completed",
    "repo": "schift-io/schift-ai-memory",
    "branch": "main"
  },
  "content_policy": {
    "raw_transcript": false,
    "artifacts": "selected",
    "redaction": "default"
  }
}
```

## Packages

- `schift-ai-memory`: unscoped npx-friendly installer CLI
- `@schift-io/ai-memory`: scoped installer CLI
- `@schift-io/ai-memory-core`: metadata, redaction, queue, and upload helpers
- `@schift-io/ai-memory-hooks`: Codex and Claude lifecycle hook commands
- `@schift-io/ai-memory-mcp`: MCP server package

## Local Development

```bash
npm install
npm run build
npm run lint
npm test
npm audit --audit-level=high
```

## Privacy and Security

Read [docs/privacy.md](docs/privacy.md) before changing upload behavior.
The intended default is summary and metadata upload only. Treat raw transcript
capture as an explicit opt-in feature, not a default install behavior.
