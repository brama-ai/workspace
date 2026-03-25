# Pipeline Handoff

- **Task**: # Task: Remove knowledge-agent

## Summary

Remove the `knowledge-agent` from the platform. This agent is no longer needed and should be fully removed from the codebase, deployment manifests, and documentation.

## Background

The `knowledge-agent` was created for knowledge management purposes but is no longer required. Removing it will:
- Reduce operational overhead
- Simplify the codebase
- Remove unused Kubernetes resources
- Clean up documentation

## Goals

1. **Remove agent code** — Delete the agent directory and all related files
2. **Remove Helm charts** — Delete deployment manifests
3. **Remove documentation** — Delete PRD and agent docs (if any)
4. **Update references** — Remove from INDEX.md, AGENTS.md, workflow.md
5. **Clean up database** — Remove from agent_registry (if registered)

## Deliverables

### 1. Remove Agent Code

Delete the following directories:
```
agents/knowledge-agent/              # Agent source code
brama-core/deploy/charts/brama/templates/agents/knowledge-agent.yaml  # Helm template (if exists)
```

### 2. Remove Documentation

Delete the following files (if they exist):
```
brama-core/docs/agents/en/knowledge-agent.md
brama-core/docs/agents/ua/knowledge-agent.md
```

Note: According to INDEX.md, knowledge-agent has no PRD yet — only source code exists.

### 3. Update References

Update the following files to remove knowledge-agent references:

| File | Action |
|------|--------|
| `INDEX.md` | Remove from Deployed Agents table |
| `agentic-development/AGENTS.md` | Remove from agent table (if present) |
| `docs/agent-development/en/workflow.md` | Remove from diagrams (if present) |
| `brama-core/src/config/agent-card.schema.json` | No changes needed (schema is generic) |

### 4. Database Cleanup

After deployment, the agent may still be registered in `agent_registry`:
```sql
DELETE FROM agent_registry WHERE name = 'knowledge-agent';
```

## Non-Goals

- Removing shared infrastructure (PostgreSQL, Redis, RabbitMQ)
- Modifying core platform code
- Removing other agents

## Acceptance Criteria

1. ✅ `agents/knowledge-agent/` directory deleted
2. ✅ Helm template deleted (if existed)
3. ✅ Documentation files deleted (if existed)
4. ✅ INDEX.md updated (agent removed from table)
5. ✅ No references remaining in codebase

## Profile Recommendation

**Profile:** `quick-fix`

**Rationale:** This is a straightforward deletion task with no code changes to shared components.

**Agents:** `u-coder`, `u-validator`, `u-summarizer`

## References

- Agent directory: `agents/knowledge-agent/`
- Helm templates: `brama-core/deploy/charts/brama/templates/agents/`
- INDEX.md: `INDEX.md`
- AGENTS.md: `agentic-development/AGENTS.md`

## Notes

- This is a non-breaking change — no external consumers exist
- The agent was never in production use
- After removal, run `agent:discovery` to verify clean registry
- **Started**: 2026-03-25 13:54:00
- **Branch**: pipeline/remove-knowledge-agent
- **Pipeline ID**: 20260325_135354

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

