# Install For Codex

Codex distribution uses a plugin marketplace entry. The plugin bundles:

- the default `schift.coding-agent.default` role package
- a skill that tells Codex how to summarize AI work safely
- an MCP config for Schift memory search/fetch
- lifecycle hooks for uploading summaries, with local queue fallback

Add the marketplace:

```bash
codex plugin marketplace add schift-io/schift-ai-memory --sparse .agents/plugins
```

Then open `/plugins` in Codex and install **Schift AI Memory**.

Run the installer first so hooks can read `~/.schift/ai-memory/config.json`:

```bash
npx -y @schift-io/ai-memory init
```

Hooks upload summary and metadata by default when a local API key exists. To
avoid a live identity lookup on every session, hooks use cached `org_id`,
`user_id`, and security metadata from `~/.schift/ai-memory/config.json`.
If upload returns `401` or `403`, the config is marked `revoked_or_invalid` and
the event is queued. To force local queue-only mode:

```bash
export SCHIFT_AI_MEMORY_UPLOAD=0
```

The MCP server also reads the same login config by default, so Codex can use
MCP `search` and `fetch` against the user's Schift bucket without a separate
API key copy in the Codex plugin config.
