# Privacy Defaults

Schift AI Memory is designed to capture what work happened, not every raw token
that passed through an AI session.

Default event upload:

- Schift `/v1/auth/me` user/security metadata
- job title
- job intent
- status
- harness source
- repo and git metadata when available
- concise summary
- artifact pointers when selected

Not uploaded by default:

- raw transcript
- full file contents
- broad command output
- unredacted secrets
- whole local directories

Raw transcript and artifact upload are separate opt-in policies.

Default destination:

```text
bucket: default
collection: _daily_log
```
