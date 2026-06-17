---
name: schift-ai-memory
description: Capture user-approved AI work summaries, job metadata, and artifact pointers into Schift company memory while avoiding raw secret or transcript upload by default.
---

# Schift AI Memory

Use this skill when the user wants AI work saved into Schift company memory,
searched from Schift memory, or prepared for another teammate to continue.

Default behavior:

1. Prefer a concise job summary over raw transcript upload.
2. Attach job metadata: source harness, repo, branch, commit, cwd, job type,
   intent, status, and visible artifact paths.
3. Redact secrets, tokens, emails, and local user paths before upload.
4. Treat raw transcripts and broad artifact upload as explicit opt-in only.
5. Use the Schift MCP server for search/fetch before asking the user to paste
   company context manually.

When summarizing a session, include:

- what the user was trying to do
- what changed or was learned
- current status
- verification performed
- remaining blockers or risks
- file paths or commit ids when relevant

Do not describe internal bucket ids unless the user is debugging routing. Use
the company/workspace name in user-facing text.

