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
    "allowed_collections": ["__schift_ai_daily_log"]
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

## Reserved System Collection

The default CodingAgent collection is a reserved Schift system collection:

```text
__schift_ai_daily_log
```

The `__schift_` prefix is reserved for Schift-owned system collections. Users
should not be allowed to create arbitrary user collections with this prefix.

During `POST /v1/auth/cli/code-exchange`, the server should ensure this
collection exists inside the authorized bucket before returning the credential:

1. Resolve or create the user's default bucket, normally `default`.
2. Resolve or create `__schift_ai_daily_log` as a system collection under that
   bucket.
3. Persist the API key with `allowed_buckets: ["default"]` and
   `allowed_collections: ["__schift_ai_daily_log"]`.
4. Return the resolved collection in the code-exchange response.

Suggested response extension:

```json
{
  "credential": {
    "allowed_buckets": ["default"],
    "allowed_collections": ["__schift_ai_daily_log"]
  },
  "defaults": {
    "bucket": "default",
    "collection": "__schift_ai_daily_log",
    "collection_id": "col_..."
  }
}
```

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
allows `bucket: default` and `collection: __schift_ai_daily_log`,
search/upload must reject other targets with `403`.

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
collection: __schift_ai_daily_log
```

## Negative Tests Required Server-Side

- A key without `ai_memory:read` cannot use bucket search or memory search.
- A key without `ai_memory:write` cannot upload hook events.
- A key without `buckets:read` cannot list buckets or collections.
- A key scoped to `default` cannot search or upload to another bucket.
- A key scoped to `__schift_ai_daily_log` cannot write to a different collection.
- A revoked key returns `401` or `403`.

## 구현 현황 (2026-08-06, scope/retention 분리 태스크)

- **저장까지는 됨.** `schift-api` `api_keys.allowed_buckets`/`allowed_collections`
  컬럼(SQLite/Postgres 둘 다)과 `store.create_api_key(...)`/`revoke_api_keys_for_user(...)`
  가 이 값을 정확히 쓰고 읽는다. CLI ai_memory 키 발급 경로
  (`server/auth/sessions.py build_cli_exchange_payload`)도 이제
  `allowed_buckets=[bucket_id]`, `allowed_collections=[collection_id]` 로
  기본 bucket/collection 만 채운다(둘 다 확보 못 하면 `[]` = 전부 거부, 무제한
  이 아님).
- **요청 시점 강제(이 문서 「Required Enforcement」 표의 핵심)는 아직 없다.**
  `server/deps.py`(auth 미들웨어)와 `server/features/bucket_upload/metadata.py`
  등 실제 검사 지점이 `allowed_buckets`/`allowed_collections` 를 아직 읽지
  않는다 — 같은 org 안의 다른 bucket 에 이 키로 write/search 가 여전히
  통과한다. 다음 단계는 `resolve_auth_context`(deps.py)가
  `api_key_record.get("allowed_buckets")`/`allowed_collections` 를 auth_context
  에 실어 보내고, bucket/collection 을 다루는 라우트가 그 목록과 대조해
  `403` 을 내는 것 — store 계약은 끝났고 미들웨어 배선만 남았다.
- **offboarding 시 키 폐기는 됨.** `remove_member_from_org` 가
  `revoke_api_keys_for_user`(즉시 만료, 행은 안 지움)를 호출해 감사 로그
  `org.member_offboarded.keys_revoked` 를 남긴다 — 위 「A revoked key returns
  401 or 403」 항목은 이제 참이다(`schift-api/tests/test_offboarding_lifecycle_scope_retention.py`).
- Workflow tools require a separate workflow execution scope.
