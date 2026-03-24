---
name: deployer
description: "Deployer role: deployment strategy workflows, safety gate checklist, SSH integration, health verification"
---

## Overview

The deployer is Phase 8 of the pipeline — an **opt-in** agent that takes completed, validated changes and deploys them to the target environment.

**Default behavior: dry-run.** The deployer shows what it would do without executing unless `dry_run: false` is explicitly set.

---

## Pre-Deployment Checklist (MANDATORY)

Run this checklist before any deployment action:

```
[ ] 1. deploy: true is present in task metadata or pipeline config
[ ] 2. dry_run: false is explicitly set (otherwise run in dry-run mode)
[ ] 3. All previous pipeline stages (Phases 1–7) completed successfully
        - Check handoff.md for each phase status
        - If ANY phase shows failed/error/timeout → REFUSE to deploy
[ ] 4. Deployment strategy is configured and valid (one of: pr-only, merge-and-deploy, direct-ssh, helm-upgrade)
[ ] 5. Required tools are available:
        - pr-only / merge-and-deploy: gh CLI available (`gh --version`)
        - direct-ssh / helm-upgrade: SSH config in .devcontainer/.ssh-env
[ ] 6. For direct-ssh / helm-upgrade: rollback plan is documented BEFORE executing
```

If any check fails → **STOP**, report the failure, mark deployment as `skipped` or `failed`.

---

## Deployment Strategies

### Strategy: `pr-only` (Default — Safest)

**When to use:** Default for all tasks. Safest option — no direct server access.

**Workflow:**

1. Verify pre-deployment checklist passes
2. Check current branch is not `main`/`master` (refuse if so)
3. Push branch to remote:
   ```bash
   git push origin HEAD
   # If rejected: report conflict, STOP — never force-push
   ```
4. Create GitHub PR:
   ```bash
   gh pr create \
     --title "<task title>" \
     --body "$(cat <<'EOF'
   ## Summary
   <bullet points from handoff.md Summarizer section>

   ## Pipeline Status
   All pipeline stages passed. See handoff.md for details.

   ## Changes
   <list of modified files from handoff.md Coder section>
   EOF
   )"
   ```
5. Report PR URL in handoff

**Dry-run output:**
```
[DRY-RUN] Would push branch: <branch-name>
[DRY-RUN] Would create PR: "<title>"
[DRY-RUN] No changes executed.
```

**Rollback:** Close the PR. No server state was changed.

---

### Strategy: `merge-and-deploy`

**When to use:** When CI/CD pipeline handles deployment automatically after merge.

**Workflow:**

1. Verify pre-deployment checklist passes
2. Push branch and create PR (same as `pr-only` steps 3–4)
3. Enable auto-merge:
   ```bash
   gh pr merge --auto --squash
   ```
4. Wait for CI to complete (poll PR status):
   ```bash
   gh pr checks --watch
   ```
5. After CI deploy completes, verify health:
   ```bash
   curl -f -s --max-time 30 <health_endpoint>
   # Expect: HTTP 200 with {"status": "ok"}
   ```
6. Report result in handoff

**Dry-run output:**
```
[DRY-RUN] Would push branch: <branch-name>
[DRY-RUN] Would create PR and enable auto-merge
[DRY-RUN] Would wait for CI deploy and verify health at: <health_endpoint>
[DRY-RUN] No changes executed.
```

**Rollback:** Revert the merge commit via `git revert` and push. CI will redeploy the previous state.

---

### Strategy: `direct-ssh`

**When to use:** Legacy Docker Compose servers without CI/CD.

**Prerequisites:**
- SSH config in `.devcontainer/.ssh-env` (variables: `SSH_HOST`, `SSH_USER`, `SSH_PORT`, `APP_PATH`)
- MCP SSH tools available

**Workflow:**

1. Verify pre-deployment checklist passes
2. **Document rollback plan BEFORE executing:**
   ```
   Rollback: SSH to server, cd <APP_PATH>, git revert HEAD, docker compose up -d --build
   ```
3. Read SSH config from `.devcontainer/.ssh-env`
4. Verify SSH connectivity:
   ```bash
   # Via MCP SSH: ssh_connect(host=SSH_HOST, username=SSH_USER, port=SSH_PORT)
   # Run: echo "connectivity check"
   ```
5. Execute deployment:
   ```bash
   cd <APP_PATH>
   git pull origin <branch>
   docker compose up -d --build
   ```
6. Verify health:
   ```bash
   curl -f -s --max-time 60 <health_endpoint>
   # Expect: HTTP 200 with {"status": "ok"}
   ```
7. Report result in handoff. On failure: include rollback plan.

**Dry-run output:**
```
[DRY-RUN] Would connect to: <SSH_HOST>:<SSH_PORT> as <SSH_USER>
[DRY-RUN] Would execute on server:
  cd <APP_PATH>
  git pull origin <branch>
  docker compose up -d --build
[DRY-RUN] Would verify health at: <health_endpoint>
[DRY-RUN] No changes executed.
```

**Rollback procedure:**
```bash
# SSH to server
cd <APP_PATH>
git log --oneline -5          # identify previous commit
git revert HEAD               # or: git reset --hard <previous-sha>
docker compose up -d --build
curl -f <health_endpoint>     # verify rollback succeeded
```

---

### Strategy: `helm-upgrade`

**When to use:** K3s/Kubernetes servers managed with Helm.

**Prerequisites:**
- SSH config in `.devcontainer/.ssh-env` (variables: `SSH_HOST`, `SSH_USER`, `SSH_PORT`)
- Helm release name and values file path configured
- New image tag available (from CI build or registry)

**Workflow:**

1. Verify pre-deployment checklist passes
2. **Document rollback plan BEFORE executing:**
   ```
   Rollback: helm rollback <release-name> [revision]
   ```
3. Read SSH config from `.devcontainer/.ssh-env`
4. Verify SSH connectivity (same as `direct-ssh` step 4)
5. Execute Helm upgrade:
   ```bash
   helm upgrade --install <release-name> <chart-path> \
     --set image.tag=<new-tag> \
     --values <values-file> \
     --wait --timeout 5m
   ```
6. Verify rollout:
   ```bash
   kubectl rollout status deployment/<deployment-name> --timeout=5m
   ```
7. Verify health:
   ```bash
   curl -f -s --max-time 60 <health_endpoint>
   # Expect: HTTP 200 with {"status": "ok"}
   ```
8. Report result in handoff. On failure: include rollback plan.

**Dry-run output:**
```
[DRY-RUN] Would connect to: <SSH_HOST>:<SSH_PORT> as <SSH_USER>
[DRY-RUN] Would execute:
  helm upgrade --install <release-name> <chart-path> --set image.tag=<new-tag> --wait
  kubectl rollout status deployment/<deployment-name>
[DRY-RUN] Would verify health at: <health_endpoint>
[DRY-RUN] No changes executed.
```

**Rollback procedure:**
```bash
# SSH to server
helm history <release-name>           # list revisions
helm rollback <release-name> <rev>    # roll back to previous revision
kubectl rollout status deployment/<deployment-name>
curl -f <health_endpoint>             # verify rollback succeeded
```

---

## Safety Gates

### Gate 1: Explicit Opt-In

```
IF task metadata does NOT contain `deploy: true`:
  → SKIP deployment entirely
  → Report: "Deployment skipped: deploy: true not found in task metadata"
  → Status: skipped
```

### Gate 2: Dry-Run Default

```
IF configuration does NOT contain `dry_run: false`:
  → Run in dry-run mode
  → Show all planned actions without executing
  → Report: "[DRY-RUN] Deployment plan shown. Set dry_run: false to execute."
  → Status: dry-run
```

### Gate 3: Pipeline Stage Verification

```
Read handoff.md and check each phase status:
  - Coder: must be "done" or "completed"
  - Validator: must be "done" or "completed" (not "failed")
  - Tester: must be "done" or "completed" (not "failed")
  - Summarizer: must be "done" or "completed"

IF any required phase shows failed/error/timeout:
  → REFUSE to deploy
  → Report: "Deployment blocked: <phase> reported failure"
  → Status: failed
```

### Gate 4: No Force-Push

```
NEVER use: git push --force
NEVER use: git push --force-with-lease
IF push is rejected:
  → Report the conflict
  → STOP — do not attempt to force
  → Status: failed
```

### Gate 5: No Production Without Confirmation

```
IF target environment is "production" AND no explicit confirmation in config:
  → REFUSE to deploy
  → Report: "Production deployment requires explicit confirmation in pipeline config"
  → Status: blocked
```

---

## SSH Integration

### Reading SSH Configuration

SSH credentials are stored in `.devcontainer/.ssh-env`. Read this file to get connection parameters:

```bash
# Expected variables in .ssh-env:
SSH_HOST=<server-hostname-or-ip>
SSH_USER=<username>
SSH_PORT=<port, default 22>
APP_PATH=<absolute path to app on server>
HEALTH_ENDPOINT=<http://host/health>
```

**NEVER log or expose SSH credentials in:**
- Pipeline handoff output
- Commit messages
- PR descriptions
- Any file written to the repository

### MCP SSH Connection

Use MCP SSH tools for server access:

```
1. ssh_connect(host=SSH_HOST, username=SSH_USER, port=SSH_PORT)
   → Returns connectionId

2. ssh_exec(connectionId=..., command="echo connectivity check")
   → Verify connection works before deployment

3. ssh_exec(connectionId=..., command="<deployment commands>")
   → Execute deployment

4. ssh_disconnect(connectionId=...)
   → Always disconnect after deployment
```

### Connection Failure Handling

```
IF ssh_connect fails (timeout / auth failure / unreachable):
  → Report: "SSH connection failed: <error>"
  → Do NOT attempt any deployment actions
  → Status: failed
  → Include: "Check .devcontainer/.ssh-env configuration"
```

---

## Health Verification

After any deployment that modifies the running environment (`direct-ssh`, `helm-upgrade`, `merge-and-deploy`):

```bash
# Health check command
curl -f -s --max-time 60 <HEALTH_ENDPOINT>
# Expected: HTTP 200, body contains {"status": "ok"}
```

**Retry policy:** 3 attempts with 10-second intervals before declaring failure.

**On health check failure:**
1. Report: "Health check failed after deployment"
2. Include rollback plan in the failure report
3. Mark deployment as: `failed — requires manual intervention`
4. Do NOT attempt automatic rollback (risk of making things worse)

---

## Handoff Output Format

Append to `.opencode/pipeline/handoff.md` — **Deployer** section:

```markdown
## Deployer

- **Status**: deployed | dry-run | skipped | failed
- **Strategy**: pr-only | merge-and-deploy | direct-ssh | helm-upgrade
- **Dry-run**: true | false
- **Actions taken**:
  - [list of actions executed or planned]
- **PR URL**: <url> (if applicable)
- **Health check**: passed | failed | skipped
- **Rollback plan**: <rollback steps> (for direct-ssh / helm-upgrade)
- **Notes**: <any warnings or issues>
```

---

## References (load on demand)

| What | Path | When |
|------|------|------|
| SSH config | `.devcontainer/.ssh-env` | direct-ssh / helm-upgrade strategies |
| Handoff bus | `.opencode/pipeline/handoff.md` | Verify previous stages passed |
| Pipeline spec | `brama-core/openspec/changes/add-deployer-pipeline-agent/` | Full requirements |
| GitHub CLI docs | `gh pr create --help` | PR creation options |
