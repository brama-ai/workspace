# Pipeline Handoff

- **Task**: # Task: Remove dev-reporter-agent

## Summary

Remove the `dev-reporter-agent` from the platform. This agent is no longer needed and should be fully removed from the codebase, deployment manifests, and documentation.

## Background

The `dev-reporter-agent` was created for development reporting purposes but is no longer required. Removing it will:
- Reduce operational overhead
- Simplify the codebase
- Remove unused Kubernetes resources
- Clean up documentation

## Goals

1. **Remove agent code** — Delete the agent directory and all related files
2. **Remove Helm charts** — Delete deployment manifests
3. **Remove documentation** — Delete PRD and agent docs
4. **Update references** — Remove from INDEX.md, AGENTS.md, workflow.md
5. **Clean up database** — Remove from agent_registry (if registered)

## Deliverables

### 1. Remove Agent Code

Delete the following directories:
```
agents/dev-reporter-agent/           # Agent source code
brama-core/deploy/charts/brama/templates/agents/dev-reporter-agent.yaml  # Helm template
```

### 2. Remove Documentation

Delete the following files:
```
brama-core/docs/agents/en/dev-reporter-agent.md
brama-core/docs/agents/ua/dev-reporter-agent.md
```

### 3. Update References

Update the following files to remove dev-reporter-agent references:

| File | Action |
|------|--------|
| `INDEX.md` | Remove from Deployed Agents table |
| `agentic-development/AGENTS.md` | Remove from agent table |
| `docs/agent-development/en/workflow.md` | Remove from diagrams (if present) |
| `brama-core/src/config/agent-card.schema.json` | No changes needed (schema is generic) |

### 4. Database Cleanup

After deployment, the agent may still be registered in `agent_registry`:
```sql
DELETE FROM agent_registry WHERE name = 'dev-reporter-agent';
```

## Non-Goals

- Removing shared infrastructure (PostgreSQL, Redis, RabbitMQ)
- Modifying core platform code
- Removing other agents

## Acceptance Criteria

1. ✅ `agents/dev-reporter-agent/` directory deleted
2. ✅ Helm template deleted
3. ✅ Documentation files deleted
4. ✅ INDEX.md updated (agent removed from table)
5. ✅ AGENTS.md updated (agent removed from table)
6. ✅ No references remaining in codebase

## Profile Recommendation

**Profile:** `quick-fix`

**Rationale:** This is a straightforward deletion task with no code changes to shared components.

**Agents:** `u-coder`, `u-validator`, `u-summarizer`

## References

- Agent directory: `agents/dev-reporter-agent/`
- Helm templates: `brama-core/deploy/charts/brama/templates/agents/`
- Agent docs: `brama-core/docs/agents/en/`, `brama-core/docs/agents/ua/`
- INDEX.md: `INDEX.md`
- AGENTS.md: `agentic-development/AGENTS.md`

## Notes

- This is a non-breaking change — no external consumers exist
- The agent was never in production use
- After removal, run `agent:discovery` to verify clean registry
- **Started**: 2026-03-25 13:53:17
- **Branch**: pipeline/remove-dev-reporter-agent
- **Pipeline ID**: 20260325_135313

---

## Architect

- **Status**: pending
- **Change ID**: —
- **Apps affected**: —
- **DB changes**: —
- **API changes**: —

## Coder

- **Status**: pending
- **Files modified**: —
- **Migrations created**: —
- **Deviations**: —

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

