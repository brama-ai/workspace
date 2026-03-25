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
[ ] 4. Deployment strategy is configured and valid (one of: ghcr-deploy, pr-only, merge-and-deploy, direct-ssh, helm-upgrade)
[ ] 5. Required tools are available:
        - ghcr-deploy: gh CLI available (`gh --version`), SSH config in .devcontainer/.ssh-env
        - pr-only / merge-and-deploy: gh CLI available (`gh --version`)
        - direct-ssh / helm-upgrade: SSH config in .devcontainer/.ssh-env
[ ] 6. For direct-ssh / helm-upgrade / ghcr-deploy: rollback plan is documented BEFORE executing
```

If any check fails → **STOP**, report the failure, mark deployment as `skipped` or `failed`.

---

## Deployment Strategies

### Strategy: `ghcr-deploy` (Recommended for K3s)

**When to use:** Primary strategy for brama-core and agents with GHCR CI/CD. Push to main triggers a GitHub Actions build that publishes to `ghcr.io`. Then update the image on the K3s server.

**GHCR Image Registry:**

| Service | Image | GitHub Repo | Build Time |
|---------|-------|-------------|------------|
| brama-core | `ghcr.io/brama-ai/brama-core` | `brama-ai/core` | ~2.5 min |
| hello-agent | `ghcr.io/brama-ai/hello-agent` | `brama-ai/hello-agent` | ~2 min |
| news-agent | `ghcr.io/brama-ai/news-agent` | `brama-ai/news-agent` | ~2 min |

Tags: `latest` (main branch), short SHA (e.g., `3500f79`)

**K3s Deployment Mapping:**

| Service | K8s Deployment | Container Name | Health Endpoint |
|---------|---------------|----------------|-----------------|
| brama-core | `brama-core` | `core` | `/health` |
| core-scheduler | `brama-core-scheduler` | `scheduler` | — |
| hello-agent | `brama-agent-hello` | `hello` | `/health` |
| news-agent | `brama-agent-news` | `news` | `/health` |

**K3s Namespace:** `brama`

**Prerequisites:**
- GitHub Actions workflow `build-and-push.yml` configured in the target repo (all repos above have it)
- SSH config in `.devcontainer/.ssh-env`
- K3s cluster with `kubectl` and `helm` on server
- GHCR images are public (no imagePullSecrets needed)

**Workflow:**

1. Verify pre-deployment checklist passes
2. **Document rollback plan BEFORE executing:**
   ```
   Rollback: kubectl rollout undo deployment/<name> -n brama
   ```
3. Determine which service(s) to deploy from handoff context
4. Push changes to main (or merge PR into main) in the target repo:
   ```bash
   # For core:
   cd brama-core && git push origin main
   # For hello-agent:
   cd brama-agents/hello-agent && git push origin main
   # For news-agent:
   cd brama-agents/news-maker-agent && git push origin main
   # If rejected: report conflict, STOP — never force-push
   ```
5. Wait for GHCR image build to complete:
   ```bash
   # Determine the repo name from the service
   REPO="brama-ai/core"  # or brama-ai/hello-agent, brama-ai/news-agent

   # Poll the Build & Push workflow
   RUN_ID=$(gh run list --workflow=build-and-push.yml -R "$REPO" --limit 1 --json databaseId --jq '.[0].databaseId')
   while true; do
     RESULT=$(gh run view "$RUN_ID" -R "$REPO" --json status,conclusion --jq '{s: .status, c: .conclusion}')
     STATUS=$(echo "$RESULT" | jq -r '.s')
     if [[ "$STATUS" == "completed" ]]; then
       CONCLUSION=$(echo "$RESULT" | jq -r '.c')
       if [[ "$CONCLUSION" == "success" ]]; then
         echo "Image built successfully"
         break
       else
         echo "Build FAILED"; exit 1
       fi
     fi
     echo "Building... ($STATUS)"
     sleep 30
   done
   ```
6. Read SSH config from `.devcontainer/.ssh-env`
7. SSH to server and update the deployment(s):
   ```bash
   ssh <SSH_USER>@<SSH_HOST> -p <SSH_PORT> "
     export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

     # Update specific service (use IMAGE_TAG=latest or short SHA)
     kubectl set image deployment/brama-core -n brama \
       core=ghcr.io/brama-ai/brama-core:latest
     kubectl rollout status deployment/brama-core -n brama --timeout=3m

     # For agents:
     # kubectl set image deployment/brama-agent-hello -n brama \
     #   hello=ghcr.io/brama-ai/hello-agent:latest
     # kubectl set image deployment/brama-agent-news -n brama \
     #   news=ghcr.io/brama-ai/news-agent:latest
   "
   ```
8. Verify health (via SSH or public URL):
   ```bash
   # Via public URL (if Cloudflare Tunnel configured):
   curl -f -s --max-time 30 https://brama.dev/health
   curl -f -s --max-time 30 https://hello.brama.dev/health

   # Via kubectl (always works):
   ssh <SSH_USER>@<SSH_HOST> -p <SSH_PORT> "
     export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
     kubectl exec -n brama deployment/brama-core -- curl -sf http://localhost/health
     kubectl exec -n brama deployment/brama-agent-hello -- curl -sf http://localhost/health
   "
   ```
9. Report result in handoff

**Deploy multiple services at once:**
```bash
ssh <SSH_USER>@<SSH_HOST> -p <SSH_PORT> "
  export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
  kubectl set image deployment/brama-core -n brama core=ghcr.io/brama-ai/brama-core:latest
  kubectl set image deployment/brama-core-scheduler -n brama scheduler=ghcr.io/brama-ai/brama-core:latest
  kubectl set image deployment/brama-agent-hello -n brama hello=ghcr.io/brama-ai/hello-agent:latest
  kubectl set image deployment/brama-agent-news -n brama news=ghcr.io/brama-ai/news-agent:latest
  kubectl rollout status deployment -n brama --timeout=5m
"
```

**Dry-run output:**
```
[DRY-RUN] Would push to main in <repo> and trigger GHCR build
[DRY-RUN] Would wait for image: ghcr.io/brama-ai/<service>:<tag>
[DRY-RUN] Would SSH to <SSH_HOST> and run:
  kubectl set image deployment/<deployment> -n brama <container>=ghcr.io/brama-ai/<service>:<tag>
[DRY-RUN] Would verify health at: <health_endpoint>
[DRY-RUN] No changes executed.
```

**Rollback:**
```bash
# SSH to server
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# Quick rollback (undo last update):
kubectl rollout undo deployment/brama-core -n brama
kubectl rollout status deployment/brama-core -n brama --timeout=3m

# Or via Helm (rolls back all services):
helm history brama -n brama
helm rollback brama <PREVIOUS_REVISION> -n brama

# Verify:
kubectl exec -n brama deployment/brama-core -- curl -sf http://localhost/health
```

**Advantages over direct-ssh:**
- No build on server (saves ~2-5 min of server CPU)
- No source code transfer (no `tar`/`scp`)
- Architecture-independent (GHCR builds linux/amd64 on GitHub runners)
- Image is cached and reusable across environments
- Build is auditable via GitHub Actions logs
- Compressed images are ~60-80 MB (Alpine multi-stage)

---

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
- **Strategy**: ghcr-deploy | pr-only | merge-and-deploy | direct-ssh | helm-upgrade
- **Dry-run**: true | false
- **Actions taken**:
  - [list of actions executed or planned]
- **PR URL**: <url> (if applicable)
- **Health check**: passed | failed | skipped
- **Rollback plan**: <rollback steps> (for direct-ssh / helm-upgrade)
- **Notes**: <any warnings or issues>
```

---

## Observability

The deployer can query live server state via SSH. Use these commands when asked to inspect logs, DB, or cluster state.

### Kubernetes Logs

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# Tail logs for a service
kubectl logs -n brama deployment/brama-core --tail=100

# Follow logs live
kubectl logs -n brama deployment/brama-core -f

# Logs for a specific pod
kubectl logs -n brama <pod-name> --tail=50

# All pods matching a label
kubectl logs -n brama -l app.kubernetes.io/component=core --tail=50

# Previous crashed container
kubectl logs -n brama deployment/brama-core-scheduler --previous --tail=50
```

### Cluster State

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# Pod status overview
kubectl get pods -n brama -o wide

# Describe a crashing pod (events + state)
kubectl describe pod -n brama <pod-name>

# Helm release history
helm history brama -n brama

# Current deployed values
helm get values brama -n brama
```

### Database Queries

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# Run SQL via psql in postgres pod
kubectl exec -n brama brama-postgresql-0 -- \
  psql -U app -d ai_community_platform -c "<SQL>"

# Examples:
kubectl exec -n brama brama-postgresql-0 -- \
  psql -U app -d ai_community_platform \
  -c "SELECT name, health_status, created_at FROM agent_registry;"

kubectl exec -n brama brama-postgresql-0 -- \
  psql -U app -d ai_community_platform \
  -c "SELECT id, status, created_at FROM scheduled_jobs ORDER BY created_at DESC LIMIT 10;"
```

### Symfony Console Commands

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# Run any Symfony command in core pod
kubectl exec -n brama deployment/brama-core -- php bin/console <command>

# Useful commands:
kubectl exec -n brama deployment/brama-core -- php bin/console agent:discovery -v
kubectl exec -n brama deployment/brama-core -- php bin/console app:agent-health-poll -v
kubectl exec -n brama deployment/brama-core -- php bin/console debug:router | grep api
kubectl exec -n brama deployment/brama-core -- php bin/console doctrine:migrations:status
```

---

## Build on Server

Use this workflow when the devcontainer is **arm64** (Apple Silicon) and the server is **amd64**. Building locally produces the wrong architecture — always build on the server.

### Prerequisites

- Source code packed as `.tar.gz` (exclude `.git`, `vendor`, `var/cache`)
- `nerdctl` + `buildkitd` available on server (K3s default)
- `COMPOSER_ALLOW_SUPERUSER=1` set in Dockerfile if running as root

### Dockerfile Requirements

```dockerfile
# Correct order for PHP apps:
WORKDIR /var/www/html          # set WORKDIR before COPY
COPY src/ /var/www/html/
ENV COMPOSER_ALLOW_SUPERUSER=1
RUN composer install --no-dev --optimize-autoloader --no-interaction
```

### Workflow

```bash
# 1. Pack source (local)
tar czf /tmp/<app>-src.tar.gz \
    -C <app-root> \
    --exclude='.git' \
    --exclude='src/var/cache' \
    --exclude='src/var/log' \
    --exclude='src/vendor' \
    .

# 2. Transfer to server
scp -o StrictHostKeyChecking=no -F /dev/null \
    -o "ProxyCommand=socat TCP:%h:%p,connect-timeout=10 -" \
    /tmp/<app>-src.tar.gz root@<SERVER>:/tmp/

# 3. Build on server (background — SSH is unstable)
ssh root@<SERVER> "
  rm -rf /tmp/<app>-build && mkdir -p /tmp/<app>-build
  tar xzf /tmp/<app>-src.tar.gz -C /tmp/<app>-build
  nohup nerdctl --namespace k8s.io build \
      -t <image>:<tag> \
      -f /tmp/<app>-build/Dockerfile \
      /tmp/<app>-build \
      > /tmp/<app>-build.log 2>&1 &
  echo \$! > /tmp/<app>-build.pid
  echo \"Build PID: \$(cat /tmp/<app>-build.pid)\"
"

# 4. Poll build status (SSH reconnect loop)
ssh root@<SERVER> "
  if kill -0 \$(cat /tmp/<app>-build.pid 2>/dev/null) 2>/dev/null; then
    echo 'Still building...' && tail -5 /tmp/<app>-build.log
  else
    echo 'Done:' && tail -10 /tmp/<app>-build.log
    k3s ctr images ls | grep <image>
  fi
"

# 5. Verify arch — must be linux/amd64
k3s ctr images ls | grep <image>
# Expected: ... linux/amd64 ...

# 6. Restart deployment
kubectl rollout restart deployment/<name> -n <namespace>
kubectl rollout status deployment/<name> -n <namespace> --timeout=3m
```

### SSH Stability Notes

Port 22 on this server opens intermittently (~30s windows every 2-3 min). Always:
- Run long operations (`build`, `scp`) in background via `nohup`
- Poll status in separate SSH sessions
- Use `socat TCP:%h:%p,connect-timeout=10 -` as ProxyCommand

---

## References (load on demand)

| What | Path | When |
|------|------|------|
| SSH config | `.devcontainer/.ssh-env` | direct-ssh / helm-upgrade strategies |
| Handoff bus | `.opencode/pipeline/handoff.md` | Verify previous stages passed |
| Pipeline spec | `brama-core/openspec/changes/add-deployer-pipeline-agent/` | Full requirements |
| GitHub CLI docs | `gh pr create --help` | PR creation options |
