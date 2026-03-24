# Deployer Agent

The deployer is **Phase 8** of the AI Community Platform pipeline — an opt-in agent that takes completed, validated changes and deploys them to the target environment.

## Overview

The deployer closes the "last mile" gap in the pipeline. After all quality gates pass (Validator, Tester, Auditor, Summarizer), the deployer can push changes to production using one of four configurable strategies.

**Key properties:**
- Opt-in only — never runs automatically
- Dry-run by default — shows planned actions without executing
- Requires all previous stages to pass
- Never force-pushes to any branch

## Pipeline Position

```
Planner → Architect → Coder → Validator → Tester → Documenter → Summarizer → [Deployer]
                                                                               ↑
                                                                     Phase 8 (opt-in)
```

## Activation

The deployer runs only when **both** conditions are met:

1. Task metadata contains `deploy: true`
2. All previous pipeline stages (Phases 1–7) completed successfully

If either condition is not met, the deployer skips and reports why.

## Deployment Strategies

| Strategy | Description | When to use |
|----------|-------------|-------------|
| `pr-only` | Push branch + create GitHub PR | Default, safest — no server access |
| `merge-and-deploy` | Create PR + auto-merge + wait for CI deploy | When CI/CD handles deployment |
| `direct-ssh` | SSH to server, git pull, docker compose up | Legacy Docker Compose servers |
| `helm-upgrade` | SSH to server, helm upgrade with new image tag | K3s/Kubernetes servers |

### `pr-only` (Default)

Pushes the current branch and creates a GitHub PR. No server access required.

```bash
git push origin HEAD
gh pr create --title "<task title>" --body "<summary>"
```

The PR URL is reported in the pipeline handoff.

### `merge-and-deploy`

Creates a PR, enables auto-merge, and waits for CI to complete the deployment.

```bash
gh pr create ...
gh pr merge --auto --squash
gh pr checks --watch
curl -f <health_endpoint>  # verify after CI deploy
```

### `direct-ssh`

Connects to the target server via MCP SSH, pulls latest changes, and rebuilds.

```bash
# On server:
cd <APP_PATH>
git pull origin <branch>
docker compose up -d --build
curl -f <health_endpoint>  # verify health
```

Requires SSH config in `.devcontainer/.ssh-env`.

### `helm-upgrade`

Connects to the K3s/Kubernetes server and upgrades the Helm release.

```bash
# On server:
helm upgrade --install <release> <chart> --set image.tag=<tag> --wait
kubectl rollout status deployment/<name>
curl -f <health_endpoint>  # verify health
```

Requires SSH config in `.devcontainer/.ssh-env`.

## Configuration

### Task Metadata

Add to your `task.md` to enable deployment:

```yaml
---
deploy: true
deploy_strategy: pr-only        # pr-only | merge-and-deploy | direct-ssh | helm-upgrade
dry_run: false                  # default: true (dry-run mode)
health_endpoint: http://...     # required for direct-ssh, helm-upgrade, merge-and-deploy
---
```

### SSH Configuration (`.devcontainer/.ssh-env`)

Required for `direct-ssh` and `helm-upgrade` strategies:

```bash
SSH_HOST=<server-hostname-or-ip>
SSH_USER=<username>
SSH_PORT=22
APP_PATH=/path/to/app
HEALTH_ENDPOINT=http://<host>/health
```

## Safety Gates

The deployer enforces five safety gates:

| Gate | Rule |
|------|------|
| **Explicit opt-in** | `deploy: true` must be in task metadata |
| **Dry-run default** | Runs in dry-run mode unless `dry_run: false` is set |
| **Stage verification** | All previous pipeline stages must have passed |
| **No force-push** | Regular `git push` only — rejected push = stop |
| **No unconfirmed production** | Production deploys require explicit confirmation |

## Dry-Run Mode

By default, the deployer runs in dry-run mode and shows what it would do:

```
[DRY-RUN] Would push branch: pipeline/my-feature
[DRY-RUN] Would create PR: "Add streaming support to A2A gateway"
[DRY-RUN] No changes executed.
```

To execute for real, set `dry_run: false` in task metadata.

## Rollback Procedures

### `pr-only`
Close the PR. No server state was changed.

### `merge-and-deploy`
```bash
git revert <merge-commit>
git push origin main
# CI will redeploy the previous state
```

### `direct-ssh`
```bash
# SSH to server
cd <APP_PATH>
git revert HEAD
docker compose up -d --build
curl -f <health_endpoint>
```

### `helm-upgrade`
```bash
# SSH to server
helm history <release-name>
helm rollback <release-name> <previous-revision>
kubectl rollout status deployment/<name>
curl -f <health_endpoint>
```

## Environment Requirements

| Requirement | Strategies | Notes |
|-------------|-----------|-------|
| `gh` CLI | `pr-only`, `merge-and-deploy` | GitHub CLI for PR creation |
| SSH config in `.ssh-env` | `direct-ssh`, `helm-upgrade` | MCP SSH agent reads this |
| `helm` + `kubectl` on server | `helm-upgrade` | Must be installed on target server |
| Health endpoint | `direct-ssh`, `helm-upgrade`, `merge-and-deploy` | For post-deploy verification |

## Handoff Output

The deployer appends to `.opencode/pipeline/handoff.md`:

```markdown
## Deployer

- **Status**: deployed | dry-run | skipped | failed
- **Strategy**: pr-only
- **Dry-run**: true
- **Actions taken**:
  - [DRY-RUN] Would push branch: pipeline/my-feature
  - [DRY-RUN] Would create PR: "My feature"
- **PR URL**: https://github.com/org/repo/pull/123
- **Health check**: skipped (dry-run)
- **Rollback plan**: Close the PR
```

## Agent Files

| File | Purpose |
|------|---------|
| `.opencode/agents/deployer.md` | Primary agent definition (Foundry) |
| `.opencode/agents/s-deployer.md` | Subagent wrapper (Ultraworks/Sisyphus) |
| `.opencode/skills/deployer/SKILL.md` | Full strategy workflows and safety gates |

## Related Documentation

- [Pipeline Workflow](../agent-development/en/workflow.md) — full pipeline overview
- [Foundry](../agent-development/en/foundry.md) — Foundry runtime
- [Ultraworks](../agent-development/en/ultraworks.md) — Ultraworks runtime
