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

