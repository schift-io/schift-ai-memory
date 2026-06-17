# Schift AI Memory

Schift AI Memory는 Codex, Claude, Cursor, MCP에서 사용자가 AI로 처리한
작업 내용을 Schift 회사 메모리로 저장하기 위한 설치형 패키지입니다.

기본 저장 위치는 다음과 같습니다.

```text
bucket: default
collection: _daily_log
```

기본 정책은 보수적으로 잡습니다. 요약과 메타데이터를 먼저 올리고, 원문
대화나 artifact 업로드는 호스트 설정에서 명시적으로 켰을 때만 처리합니다.

## What You Get

설치하면 사용자는 다음을 얻습니다.

- `npx`로 바로 실행할 수 있는 `schift-ai-memory` CLI.
- 브라우저 OAuth 로그인.
- AI Memory 전용 API key. 일반 로그인 세션과 분리되어
  `~/.schift/ai-memory/config.json`에 저장됩니다.
- 연결 완료 전 `/v1/auth/me` 검증.
- AI 작업 로그가 기본으로 `bucket: default`,
  `collection: _daily_log`에 저장되는 경로.
- 각 세션의 job metadata: source, harness, job type, title, intent, status,
  repo, branch, content policy.
- 업로드 전 일반적인 secret과 로컬 머신 path redaction.
- Codex plugin, Claude Code hook, Claude Desktop MCP, Cursor MCP, 직접 MCP
  실행까지 이어지는 설치 표면.

## Honcho와 뭐가 다른가

Honcho는 stateful agent를 만들기 위한 memory backend에 가깝습니다. 사용자,
agent, group, project, idea가 시간에 따라 어떻게 바뀌는지 모델링하고,
AI 도구에 persistent memory와 personalization을 제공하는 쪽이 핵심입니다.

Schift AI Memory는 범위가 더 좁고 운영 로그에 가깝습니다.

- Schift AI Memory는 사용자의 AI 작업 로그를 자기 회사 Schift bucket으로
  보내기 위한 설치형 harness입니다.
- system of record는 Schift입니다. 기본 라우팅은 `bucket: default`,
  `collection: _daily_log`이고, Schift의 user/security metadata와 회사
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
npx -y schift-ai-memory login
```

이 명령은 다음 순서로 동작합니다.

1. 로컬 callback 서버를 엽니다.
2. 브라우저에서 Schift OAuth 화면을 엽니다.
3. 사용자가 로그인하고 AI Memory 접근을 승인합니다.
4. callback code를 받아 AI Memory 전용 API key로 교환합니다.
5. `/v1/auth/me`로 사용자와 security metadata를 확인합니다.
6. `~/.schift/ai-memory/config.json`에 로컬 설정을 저장합니다.

저장 위치를 명시하고 싶으면 이렇게 실행합니다.

```bash
npx -y schift-ai-memory login --bucket default --collection _daily_log
```

scoped package 형태도 사용할 수 있습니다.

```bash
npx -y --package @schift-io/ai-memory schift-ai-memory login
```

## 설치 계획 미리 보기

```bash
npx -y schift-ai-memory init
```

Codex, Claude, Claude Desktop, Cursor, MCP에 넣을 설정을 JSON으로 보여줍니다.

## Codex

Codex marketplace 설치 명령을 출력합니다.

```bash
npx -y schift-ai-memory codex-marketplace
```

현재 출력:

```bash
codex plugin marketplace add schift-io/schift-ai-memory --sparse .agents/plugins
```

Codex plugin bundle에는 다음이 들어갑니다.

- MCP 설정
- lifecycle hook 설정
- Schift AI Memory skill
- metadata와 upload 기본값

## Claude Code

Claude Code hook 설정을 출력합니다.

```bash
npx -y schift-ai-memory claude-code-settings --print
```

예시 설정 파일을 생성합니다.

```bash
npx -y schift-ai-memory claude-code-settings
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
SCHIFT_API_KEY=sk-...
SCHIFT_DEFAULT_BUCKET=default
SCHIFT_COLLECTION=_daily_log
```

`schift-ai-memory init`은 Cursor에 넣을 수 있는 MCP 설정 블록도 출력합니다.

## 무엇이 올라가나

이벤트 예시는 다음 명령으로 확인할 수 있습니다.

```bash
npx -y schift-ai-memory metadata-example
```

대략 이런 형태입니다.

```json
{
  "source": "codex",
  "harness": "codex-plugin",
  "company_bucket": "default",
  "collection": "_daily_log",
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
