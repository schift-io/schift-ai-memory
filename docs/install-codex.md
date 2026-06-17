# Install For Codex

Codex distribution uses a plugin marketplace entry. The plugin bundles:

- a skill that tells Codex how to summarize AI work safely
- an MCP config for Schift memory search/fetch
- opt-in lifecycle hooks for queueing summaries

Add the marketplace:

```bash
codex plugin marketplace add schift-io/schift-ai-memory --sparse .agents/plugins
```

Then open `/plugins` in Codex and install **Schift AI Memory**.

Set local environment variables before enabling upload:

```bash
export SCHIFT_API_KEY=sk-...
export SCHIFT_COMPANY_BUCKET=default
export SCHIFT_COLLECTION=_daily_log
```

By default, hook commands queue local summaries. Set this only after reviewing
the hook behavior:

```bash
export SCHIFT_AI_MEMORY_UPLOAD=1
```
