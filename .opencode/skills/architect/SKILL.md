---
name: architect
description: "Architect role: OpenSpec workflow, proposal scaffold, spec format, design conventions"
---

## OpenSpec Workflow

OpenSpec is **per-project** — specs live inside each project, not at the workspace root.

Every API/architecture change MUST follow:
1. **Identify target project** — determine which project owns the change (`brama-core/`, `agents/<name>/`, etc.)
2. **Spec first** — write spec in `<project>/openspec/changes/<id>/specs/`
3. **Validate** — `cd <project> && openspec validate <id> --strict`
4. **Implement** — code matches spec contract
5. **Test** — tests validate spec scenarios

## Proposal Structure

Scaffold under `<project>/openspec/changes/<change-id>/`:

```
<project>/openspec/changes/<change-id>/
├── proposal.md                 # What and why
├── design.md                   # Architecture reasoning, trade-offs, component interactions
├── tasks.md                    # Ordered work items with - [ ] checkboxes
└── specs/
    └── <capability>/spec.md    # Spec deltas with scenarios
```

Common project paths:
- `brama-core/openspec/changes/` — platform core
- `agents/<name>/openspec/changes/` — individual agents
- `brama-website/openspec/changes/` — website

## Spec Delta Format

```markdown
## ADDED Requirements

#### Scenario: User creates payment
Given: authenticated user with valid card
When: POST /payments with amount and currency
Then: returns 201 with payment_id and status "pending"

## MODIFIED Requirements

#### Scenario: Agent manifest includes storage
Given: agent with postgres storage declared
When: GET /api/v1/manifest
Then: response includes storage.postgres.startup_migration with enabled=true

## REMOVED Requirements

#### Scenario: Legacy XML endpoint
Removed: POST /api/v1/xml-import
Reason: Replaced by JSON-based import in add-json-import
```

## Design Doc Sections

A good `design.md` covers:
- **Problem** — what's broken or missing
- **Approach** — chosen solution with reasoning
- **Alternatives considered** — why rejected
- **Component interactions** — which apps/services are affected
- **Data model** — new tables, columns, indexes
- **API surface** — new/changed endpoints
- **Risks** — what could go wrong, mitigation

## Task Breakdown Rules

- Tasks must be small, verifiable, and ordered by dependency
- Each task should be completable in one agent session
- Include validation criteria: "PHPStan passes", "test X green"
- Group by app when multi-app change

## Platform Context

| Component | Stack | Key Files |
|-----------|-------|-----------|
| Core | PHP 8.5, Symfony 7 | `brama-core/src/src/`, `brama-core/src/config/` |
| Knowledge agent | PHP 8.5, Symfony 7 | `agents/knowledge-agent/src/` |
| News maker | Python, FastAPI | `agents/news-maker-agent/app/` |
| Wiki agent | Node.js, TS | `agents/wiki-agent/src/` |
| Infra | Postgres, Redis, RabbitMQ | `docker/compose.yaml`, `docker/compose.core.yaml` |

## Rules

- Choose a unique verb-led `change-id` (e.g., `add-streaming-support`)
- Run `cd <project> && openspec list` first — update existing proposal if one exists
- Run `cd <project> && openspec list --specs` for existing capability specs
- Reference existing specs to avoid duplication
- Never write implementation code — only specs and docs

## References (load on demand)

| What | Path | When |
|------|------|------|
| OpenSpec conventions | `<project>/openspec/AGENTS.md` | Always — primary reference |
| Project state | `<project>/openspec/project.md` | Understanding current scope |
| Existing specs | `cd <project> && openspec list --specs` | Avoiding duplication |
| Agent conventions | `brama-core/docs/agent-requirements/conventions.md` | Agent-related changes |
| Existing proposals | `<project>/openspec/changes/` | Checking for conflicts |
