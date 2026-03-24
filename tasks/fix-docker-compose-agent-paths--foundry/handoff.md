# Pipeline Handoff

- **Task**: <!-- priority: 1 -->
# Fix Docker Compose agent paths: agents/ → brama-agents/

After workspace restructure (commit af5a05d), agent directories moved from `agents/` to `brama-agents/`. All Docker Compose files for agents still reference the old `../agents/` path, causing `docker compose build` and E2E test preparation to fail with:

```
unable to prepare context: path "/workspaces/brama/agents/news-maker-agent" not found
```

## Files to update

All `context:` and volume mount paths in these Docker Compose files:

- `docker/compose.agent-dev.yaml` — `../agents/dev-agent` → `../brama-agents/dev-agent`
- `docker/compose.agent-dev-reporter.yaml` — `../agents/dev-reporter-agent` → `../brama-agents/dev-reporter-agent`
- `docker/compose.agent-news-maker.yaml` — `../agents/news-maker-agent` → `../brama-agents/news-maker-agent`
- `docker/compose.agent-knowledge.yaml` — `../agents/knowledge-agent` → `../brama-agents/knowledge-agent`
- `docker/compose.agent-hello.yaml` — `../agents/hello-agent` → `../brama-agents/hello-agent`
- `docker/compose.agent-wiki.yaml` — `../agents/wiki-agent` → `../brama-agents/wiki-agent`

## Validation

- `docker compose -f docker/compose.yaml -f docker/compose.core.yaml -f docker/compose.agent-hello.yaml config` succeeds (config validation)
- `make e2e-env-check` passes
- All 6 compose agent files reference `../brama-agents/` instead of `../agents/`
- **Started**: 2026-03-24 12:33:42
- **Branch**: pipeline/fix-docker-compose-agent-paths-agents-brama-agents
- **Pipeline ID**: 20260324_123326

---

## Architect

- **Status**: pending
- **Change ID**: —
- **Apps affected**: —
- **DB changes**: —
- **API changes**: —

## Coder

- **Status**: done
- **Files modified**:
  - `docker/compose.agent-dev.yaml` — replaced `../agents/dev-agent` → `../brama-agents/dev-agent` (context + 2 volume mounts)
  - `docker/compose.agent-dev-reporter.yaml` — replaced `../agents/dev-reporter-agent` → `../brama-agents/dev-reporter-agent` (context + 2 volume mounts)
  - `docker/compose.agent-news-maker.yaml` — replaced `../agents/news-maker-agent` → `../brama-agents/news-maker-agent` (context + 2 volume mounts)
  - `docker/compose.agent-knowledge.yaml` — replaced `../agents/knowledge-agent` → `../brama-agents/knowledge-agent` (4 services: context + volume mounts each)
  - `docker/compose.agent-hello.yaml` — replaced `../agents/hello-agent` → `../brama-agents/hello-agent` (context + 2 volume mounts)
  - `docker/compose.agent-wiki.yaml` — replaced `../agents/wiki-agent` → `../brama-agents/wiki-agent` (context + 2 volume mounts)
- **Migrations created**: none
- **Deviations**: none — all changes are exact path replacements as specified
- **Validation**:
  - `docker compose -f docker/compose.yaml -f docker/compose.core.yaml -f docker/compose.agent-hello.yaml config` → SUCCESS
  - `make e2e-env-check` → all OK (core, knowledge, news-maker, hello, dev-reporter, openclaw all healthy)

## Validator

- **Status**: pending
- **PHPStan**: —
- **CS-check**: —
- **Files fixed**: —

## Tester

- **Status**: pending
- **Test results**: —
- **New tests written**: —

## Auditor

- **Status**: pending
- **Verdict**: —
- **Recommendations**: —

## Documenter

- **Status**: pending
- **Docs created/updated**: —

## Summarizer

- **Status**: pending
- **Summary file**: —
- **Next task recommendation**: —

---

