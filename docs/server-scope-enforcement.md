# Server Scope Enforcement Contract

Schift AI Memory clients declare their desired permissions, but the server is
the authority. Client-side identity and security metadata is provenance only.

## Code Exchange Response

`POST /v1/auth/cli/code-exchange` should return:

```json
{
  "credential": {
    "api_key": "sch_...",
    "org_id": "org_...",
    "user_id": "usr_...",
    "scopes": [
      "ai_memory:read",
      "ai_memory:write",
      "buckets:read",
      "buckets:upload"
    ],
    "allowed_buckets": ["default"],
    "allowed_collections": ["_daily_log"]
  },
  "security": {
    "level": "standard",
    "policy_version": "2026-06-17"
  }
}
```

Backward compatibility: clients also accept top-level `api_key`, `key`,
`access_token`, `org.id`, and `credential.user_id`.

## API Key Persistence

The server should persist the same authorization boundary with the API key:

- `org_id`
- `created_by` / `user_id`
- `scopes`
- `allowed_buckets`
- `allowed_collections`
- `security_policy_version`
- `expires_at` or rotation policy
- revoked/disabled state

## Required Enforcement

For every request authenticated by a `sch_` API key:

| Endpoint family | Required scope |
| --- | --- |
| `GET /v1/buckets` | `buckets:read` |
| `GET /v1/buckets/{bucket}/collections` | `buckets:read` |
| `POST /v1/buckets/{bucket}/upload` | `ai_memory:write` and `buckets:upload` |
| `POST /v2/buckets/{bucket}/search` | `ai_memory:read` |
| `POST /v1/memory/search` | `ai_memory:read` |
| `POST /v2/buckets/{bucket}/documents` | separate document upload scope, not part of default CodingAgent |
| workflow run/dry-run/list | separate workflow scope, disabled by default client-side |

Bucket and collection filters must be enforced server-side. If a key only
allows `bucket: default` and `collection: _daily_log`, search/upload must reject
other targets with `403`.

## Default CodingAgent Package

The default client role package is:

```text
schift.coding-agent.default
```

Required scopes:

```text
ai_memory:read
ai_memory:write
buckets:read
buckets:upload
```

Default route:

```text
bucket: default
collection: _daily_log
```

## Negative Tests Required Server-Side

- A key without `ai_memory:read` cannot use bucket search or memory search.
- A key without `ai_memory:write` cannot upload hook events.
- A key without `buckets:read` cannot list buckets or collections.
- A key scoped to `default` cannot search or upload to another bucket.
- A key scoped to `_daily_log` cannot write to a different collection.
- A revoked key returns `401` or `403`.
- Workflow tools require a separate workflow execution scope.
