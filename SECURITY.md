# Security Policy

Schift AI Memory is user-installed software that can observe AI-session
metadata through MCP and opt-in lifecycle hooks.

## Defaults

- Raw transcripts are not uploaded by default.
- Hooks are opt-in and should never block the host AI client.
- Events are redacted before enqueue or upload.
- API keys belong in local environment or host credential storage, not prompts.

## Reporting

Report security issues to hello@schift.io.

Please include:

- affected package and version
- host client, such as Codex or Claude Code
- reproduction steps
- whether credentials, transcript content, or local files were exposed

Do not open public issues for credential exposure or privacy-impacting bugs.

