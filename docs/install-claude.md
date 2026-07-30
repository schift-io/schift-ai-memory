# Install For Claude

Claude has two relevant install surfaces.

## Claude Code

Generate a settings snippet:

```bash
npx -y @schift-io/ai-memory init
npx @schift-io/ai-memory claude-code-settings --print
```

Review the output before merging it into `~/.claude/settings.json`.
The hook commands read `~/.schift/ai-memory/config.json`, upload summaries and
metadata by default, reuse cached identity/security metadata, and fall back to
the local queue if upload fails. A `401` or `403` marks the config
`revoked_or_invalid` without deleting the API key.

## Claude Desktop

Claude Desktop should use the `.mcpb` release asset once available.

The bundle template lives at:

```text
bundles/claude-desktop/manifest.json
```

For local development, run the MCP server directly:

```bash
npx @schift-io/ai-memory-mcp
```

After `schift-ai-memory login`, the MCP server reads
`~/.schift/ai-memory/config.json` and can retrieve uploaded logs with `search`
and `fetch`. Set `SCHIFT_API_KEY` only when you intentionally want to override
the local login config.
