# Pipeline Handoff

- **Task**: <!-- priority: 1 -->
# Create deployer agent proposal for pipeline deployment automation

## Context

Currently the platform deploys via:
1. **GitHub Actions** (`deploy.yml`): auto-detect changed services → SSH to server → `docker compose up -d --build`
2. **Manual**: `run_deploy.sh` script with SSH/expect for K3s deployment
3. **MCP SSH agent**: available in devcontainer for interactive server access

The pipeline (Foundry/Ultraworks) can produce code changes, but has no "last mile" — an agent that takes completed, validated changes and deploys them to the target environment. This is the missing **deployer** role.

## Task

Write an OpenSpec proposal at `brama-core/openspec/changes/add-deployer-pipeline-agent/proposal.md` that covers:

### 1. Deployer Agent Role in Pipeline

Add `deployer` as a new pipeline stage after `summarizer`:

```
... → Validator → Tester → Documenter → Summarizer → Deployer
```

The deployer agent should:
- Only run when explicitly requested (not on every task)
- Verify all previous stages passed (no failures)
- Push the branch, create PR, or deploy directly depending on config

### 2. Deployment Strategies

The deployer should support multiple strategies via config:

| Strategy | Description | When to use |
|----------|-------------|-------------|
| `pr-only` | Push branch + create GitHub PR | Default, safest |
| `merge-and-deploy` | Create PR + auto-merge + wait for CI deploy | When CI handles deployment |
| `direct-ssh` | SSH to server, git pull, docker compose up | Legacy Docker Compose server |
| `helm-upgrade` | SSH to server, helm upgrade with new values | K3s/Kubernetes server |

### 3. SSH Integration

- Reuse MCP SSH agent configuration from `.devcontainer/.ssh-env`
- For `direct-ssh` strategy: connect to configured server, cd to app path, pull latest, rebuild
- For `helm-upgrade` strategy: connect, update image tags, run `helm upgrade`
- Verify deployment health after execution (curl health endpoint)

### 4. Safety Gates

- Require explicit `deploy: true` in task.md metadata or pipeline config
- Dry-run mode by default (show what would happen)
- Rollback plan: document how to revert if deployment fails
- Never force-push or deploy to production without confirmation

### 5. Agent Definition Files

Propose the content for:
- `agentic-development/agents/deployer.md` (Foundry primary agent)
- `agentic-development/agents/s-deployer.md` (Ultraworks subagent wrapper)

### 6. Environment Requirements

Document what the deployer needs:
- SSH keys configured in `.ssh-env`
- GitHub CLI (`gh`) for PR creation
- Access to deployment target (server SSH or K8s cluster)

## Validation

- Proposal follows OpenSpec convention (Why, What Changes, Impact, Risks)
- All deployment strategies are clearly documented
- Safety gates are defined
- Agent definitions follow naming convention from AGENTS.md
- **Started**: 2026-03-24 15:00:00
- **Branch**: pipeline/create-deployer-agent-proposal-for-pipeline-deploy
- **Pipeline ID**: 20260324_145955

---

## Architect

- **Status**: done
- **Change ID**: `add-deployer-pipeline-agent`
- **Apps affected**: workspace-level only (`.opencode/agents/`, `.opencode/skills/`, `docs/pipeline/`). No changes to `brama-core` PHP source, `knowledge-agent`, `hello-agent`, or `news-maker-agent`.
- **DB changes**: none — deployer is a pipeline-internal agent, no schema changes
- **API changes**: none — no new or modified platform endpoints
- **Key decisions**:
  - Deployer is Phase 8 (after summarizer), optional, explicit opt-in only
  - Four strategies: `pr-only` (default/safest), `merge-and-deploy`, `direct-ssh`, `helm-upgrade`
  - Dry-run by default; requires `deploy: true` + `dry_run: false` for real execution
  - Reuses MCP SSH agent config from `.devcontainer/.ssh-env` for server access
  - Health verification via health endpoint curl after deployment
  - Force-push is unconditionally prohibited
  - Spec deltas added to existing `pipeline-agents` capability (6 new requirements, 16 scenarios)
- **Risks**:
  - SSH credential exposure → mitigated by reusing existing `.ssh-env`, never logging creds
  - Accidental production deploy → mitigated by dry-run default + explicit opt-in gate
  - Deployment failure → mitigated by mandatory rollback plan documentation before execution
- **Proposal path**: `brama-core/openspec/changes/add-deployer-pipeline-agent/`
- **Validation**: `openspec validate add-deployer-pipeline-agent --strict` — passed

## Coder

- **Status**: done
- **Files created**:
  - `.opencode/agents/deployer.md` — unified deployer agent (primary, Foundry)
  - `.opencode/agents/s-deployer.md` — Ultraworks subagent wrapper (Phase 8)
  - `.opencode/skills/deployer/SKILL.md` — full skill: 4 strategies, 5 safety gates, SSH integration, health verification, rollback procedures
  - `docs/pipeline/en/deployer-agent.md` — developer-facing English documentation
  - `docs/pipeline/ua/deployer-agent.md` — Ukrainian mirror documentation
- **Files modified**:
  - `agentic-development/AGENTS.md` — added deployer to agent table, matrix, and pipeline diagram
  - `.opencode/oh-my-opencode.jsonc` — added Phase 8 to Sisyphus prompt_append, added `s-deployer` model config with 6-provider fallback chain, added `deployment` category
  - `docs/agent-development/en/workflow.md` — added Deployer to inter-agent communication table, CONTEXT-CONTRACT note
  - `docs/agent-development/en/foundry.md` — added deployer to pipeline profiles note and agent timeouts table
  - `brama-core/openspec/changes/add-deployer-pipeline-agent/tasks.md` — marked all tasks `[x]`
- **Migrations created**: none (pipeline-internal agent, no schema changes)
- **Deviations**:
  - Task 1.3 says "update agent type enum used by the Task tool" — no such enum file exists in the codebase. The agent index is `agentic-development/AGENTS.md` (updated) and the skill registry is auto-discovered from `.opencode/skills/` directory structure. No separate enum file to update.
  - Task 2.2 says "register skill in shared skill index" — no skill index file exists. Skills are auto-discovered from `.opencode/skills/<name>/SKILL.md`. The deployer skill is registered by its presence in `.opencode/skills/deployer/SKILL.md`.

## Validator

- **Status**: done
- **PHPStan**:
  - `apps/brama-core/` — not run (unchanged)
  - `apps/knowledge-agent/` — not run (unchanged)
  - `apps/hello-agent/` — not run (unchanged)
  - `apps/news-maker-agent/` — not run (unchanged)
- **CS-check**:
  - `apps/brama-core/` — not run (unchanged)
  - `apps/knowledge-agent/` — not run (unchanged)
  - `apps/hello-agent/` — not run (unchanged)
  - `apps/news-maker-agent/` — not run (unchanged)
- **Files fixed**: none

## Tester

- **Status**: pending
- **Test results**: —
- **New tests written**: —

## Auditor

- **Status**: done
- **Verdict**: **PASS** (zero blocking findings)
- **Findings**: 3 non-blocking issues found and fixed by auditor
  - [S-01] Duplicate pipeline diagram in `agentic-development/AGENTS.md` — removed duplicate lines
  - [D-01] Broken relative links in `docs/pipeline/en/deployer-agent.md` — fixed `../` → `../../`
  - [D-02] Broken relative links in `docs/pipeline/ua/deployer-agent.md` — fixed `../` → `../../`
- **Files fixed**:
  - `agentic-development/AGENTS.md` — removed duplicate pipeline diagram
  - `docs/pipeline/en/deployer-agent.md` — fixed 3 broken relative links
  - `docs/pipeline/ua/deployer-agent.md` — fixed 3 broken relative links
- **Report**: `.opencode/pipeline/reports/20260324_145955_audit.md`
- **Recommendations**: Consider adding `docs/pipeline/INDEX.md` when more pipeline docs are added (non-blocking)

## Documenter

- **Status**: pending
- **Docs created/updated**: —

## Summarizer

- **Status**: pending
- **Summary file**: —
- **Next task recommendation**: —

---

- **Commit (architect)**: d7c2187
- **Commit (coder)**: 41a1ffc
- **Commit (auditor)**: 7cc82a2
