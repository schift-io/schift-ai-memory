# Install For Claude

Claude has two relevant install surfaces.

## Claude Code

Generate a settings snippet:

```bash
npx @schift-io/ai-memory login
npx @schift-io/ai-memory claude-code-settings --print
```

Review the output before merging it into `~/.claude/settings.json`.

## Claude Desktop

Claude Desktop should use the `.mcpb` release asset once available.

The bundle template lives at:

```text
bundles/claude-desktop/manifest.json
```

For local development, run the MCP server directly:

```bash
SCHIFT_API_KEY=sk-... npx @schift-io/ai-memory-mcp
```
