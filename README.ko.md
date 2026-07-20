# Schift AI Memory

Schift AI Memory는 Codex, Claude, Cursor, MCP에서 사용자가 AI로 처리한
작업 내용을 Schift 회사 메모리로 저장하기 위한 설치형 패키지입니다.

기본 저장 위치는 다음과 같습니다.

```text
bucket: default
collection: __schift_ai_daily_log
```

기본 정책은 보수적으로 잡습니다. 요약과 메타데이터를 먼저 올리고, 원문
대화나 artifact 업로드는 호스트 설정에서 명시적으로 켰을 때만 처리합니다.

## What You Get

설치하면 사용자는 다음을 얻습니다.

- `npx`로 바로 실행할 수 있는 `schift-ai-memory` CLI.
- 브라우저 OAuth 로그인.
- AI Memory 전용 API key. 일반 로그인 세션과 분리되어
  `~/.schift/ai-memory/config.json`에 저장됩니다.
- 연결 완료 전 Schift bucket 접근으로 API key 검증.
- OAuth code-exchange가 `org_id`, `user_id`, security metadata를 내려주면
  로컬 config에 캐시합니다. hook은 매 세션마다 `/me`를 호출하지 않고 이
  캐시를 사용합니다.
- AI 작업 로그가 기본으로 `bucket: default`,
  `collection: __schift_ai_daily_log`에 저장되는 경로. Schift bucket 안에 `__schift_ai_daily_log`
  collection이 실제로 있으면 `collection_id`를 붙이고, 없으면 문서
  metadata의 `collection` 값으로 유지합니다.
- 각 세션의 job metadata: source, harness, job type, title, intent, status,
  repo, branch, content policy.
- 업로드 전 일반적인 secret과 로컬 머신 path redaction.
- Codex plugin, Claude Code hook, Claude Desktop MCP, Cursor MCP, 직접 MCP
  실행까지 이어지는 설치 표면.
- MCP를 통한 조회: `search`, `fetch`, `schift_search`,
  `schift_memory_search`가 로그인 후 같은 Schift bucket을 읽습니다.
- CodingAgent용 기본 role package. retrieval tool, lifecycle hook, Schift
  security scope 기대값을 하나의 설치 단위로 묶습니다.

## Honcho와 뭐가 다른가

Honcho는 stateful agent를 만들기 위한 memory backend에 가깝습니다. 사용자,
agent, group, project, idea가 시간에 따라 어떻게 바뀌는지 모델링하고,
AI 도구에 persistent memory와 personalization을 제공하는 쪽이 핵심입니다.

Schift AI Memory는 범위가 더 좁고 운영 로그에 가깝습니다.

- Schift AI Memory는 사용자의 AI 작업 로그를 자기 회사 Schift bucket으로
  보내기 위한 설치형 harness입니다.
- system of record는 Schift입니다. 기본 라우팅은 `bucket: default`,
  `collection: __schift_ai_daily_log`이고, Schift의 user/security metadata와 회사
  memory boundary를 따릅니다.
- 핵심 레코드는 job/event입니다. 어떤 일을 했는지, 왜 했는지, 어떤
  harness가 했는지, 어느 repo/project였는지, 어떤 content policy였는지가
  올라갑니다.
- 기본값은 metadata-first입니다. raw transcript 캡처는 opt-in입니다.
- Codex hook, Claude hook, MCP, plugin marketplace 배포를 Schift의 기존
  bucket/auth 모델에 맞춰 패키징하는 것이 목적입니다.

정리하면, agent가 사용자를 장기적으로 모델링하게 만들고 싶으면 Honcho가
맞습니다. 팀의 AI 작업 이력, daily log, job metadata를 회사 Schift bucket과
보안 경계 안에 쌓고 싶으면 Schift AI Memory가 맞습니다.

참고:

- Honcho repository: <https://github.com/plastic-labs/honcho>
- Honcho MCP docs: <https://honcho.dev/docs/v3/guides/integrations/mcp>

## 설치

권장 시작 명령:

```bash
npx -y @schift-io/mcp init
```

이 명령은 다음 순서로 동작합니다.

1. 로컬 callback 서버를 엽니다.
2. 브라우저에서 Schift OAuth 화면을 엽니다.
3. 사용자가 로그인하고 AI Memory 접근을 승인합니다.
4. callback code를 받아 AI Memory 전용 API key로 교환합니다.
5. Schift bucket 접근으로 API key를 검증합니다.
6. 반환된 `org_id`, `user_id`, security metadata와 refresh window를
   `~/.schift/ai-memory/config.json`에 저장합니다.
7. Claude Code 예시 설정을
   `~/.claude/settings.schift-ai-memory.example.json`에 생성합니다.
8. Codex plugin과 MCP처럼 host tool 쪽에서 설치해야 하는 명령을 출력합니다.

저장 위치를 명시하고 싶으면 이렇게 실행합니다.

```bash
npx -y @schift-io/mcp init --bucket default --collection __schift_ai_daily_log
```

scoped package 형태도 사용할 수 있습니다.

```bash
npx -y --package @schift-io/ai-memory schift-ai-memory init
```

OAuth 연결만 하고 host 설정 파일은 만들고 싶지 않다면 다음을 씁니다.

```bash
npx -y @schift-io/mcp login
```

설치된 credential, bucket 접근, collection 라우팅, role package 상태를
확인하려면 다음을 씁니다.

```bash
npx -y @schift-io/mcp doctor --search
```

## 설치 계획 미리 보기

```bash
npx -y @schift-io/mcp init --print
```

OAuth를 열거나 파일을 쓰지 않고 Codex, Claude, Claude Desktop, Cursor, MCP에
넣을 설정 계획만 JSON으로 보여줍니다.

## Codex

Codex marketplace 설치 명령을 출력합니다.

```bash
npx -y @schift-io/mcp codex-marketplace
```

현재 출력:

```bash
codex plugin marketplace add schift-io/schift-ai-memory --sparse .agents/plugins
```

Codex plugin bundle에는 다음이 들어갑니다.

- 기본 `schift.coding-agent.default` role package
- MCP 설정
- lifecycle hook 설정
- Schift AI Memory skill
- metadata와 upload 기본값

## Claude Code

Claude Code hook 설정을 출력합니다.

```bash
npx -y @schift-io/mcp claude-code-settings --print
```

예시 설정 파일을 생성합니다.

```bash
npx -y @schift-io/mcp claude-code-settings
```

생성 위치:

```text
~/.claude/settings.schift-ai-memory.example.json
```

내용을 확인한 뒤 `~/.claude/settings.json`에 병합하면 됩니다.

## Claude Desktop / Cursor MCP

MCP 서버 패키지:

```bash
npx -y @schift-io/ai-memory-mcp
```

최소 환경 변수:

```text
SCHIFT_DEFAULT_BUCKET=default
SCHIFT_COLLECTION=__schift_ai_daily_log
```

`schift-ai-memory login` 또는 `schift-ai-memory init` 이후에는 MCP package가
기본으로 `~/.schift/ai-memory/config.json`을 읽습니다. 그래서 로컬 MCP
client 설정마다 `SCHIFT_API_KEY`를 복사할 필요가 없습니다. 명시적인 MCP env
값은 여전히 로컬 login config보다 우선합니다. `schift-ai-memory init --print`는
Cursor에 넣을 수 있는 MCP 설정 블록도 출력합니다.

Codex/Claude hook은 `~/.schift/ai-memory/config.json`을 읽습니다. API key가
있으면 기본으로 서버에 업로드하고, 실패하면 local queue로 fallback합니다.
Schift가 `401` 또는 `403`을 반환하면 API key 자체는 지우지 않고 config
상태를 `revoked_or_invalid`로 바꾸며 `last_upload_error`를 남깁니다.
queue-only 모드가 필요하면 `SCHIFT_AI_MEMORY_UPLOAD=0`을 설정하면 됩니다.

## 무엇이 올라가나

이벤트 예시는 다음 명령으로 확인할 수 있습니다.

```bash
npx -y @schift-io/mcp metadata-example
```

대략 이런 형태입니다.

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

## 패키지 구성

- `schift-ai-memory`: unscoped npx 설치용 CLI.
- `@schift-io/ai-memory`: scoped 설치용 CLI.
- `@schift-io/ai-memory-core`: metadata, redaction, queue, upload helper.
- `@schift-io/ai-memory-hooks`: Codex/Claude lifecycle hook command.
- `@schift-io/ai-memory-mcp`: MCP server package.

## 로컬 개발

```bash
npm install
npm run build
npm run lint
npm test
npm audit --audit-level=high
```

## Privacy / Security

업로드 정책을 바꾸기 전에는 [docs/privacy.md](docs/privacy.md)를 먼저 보세요.
기본값은 summary + metadata 업로드입니다. raw transcript 캡처는 기본 설치
동작이 아니라 명시적 opt-in 기능으로 다뤄야 합니다.
