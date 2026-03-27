# Local k3s Runtime Validation (Rancher Desktop)

> **Purpose**: Repeatable validation flow to confirm the platform runs correctly on Rancher Desktop k3s.
> **Cluster**: Rancher Desktop k3s (local machine)
> **Namespace**: `brama`
> **Helm release**: `brama`
> **Chart**: `brama-core/deploy/charts/brama`
> **Values**: `brama-core/deploy/charts/brama/values-k3s-dev.yaml`

---

## Prerequisites

| Tool | Check | Install |
|------|-------|---------|
| Rancher Desktop | Must be running with k3s enabled | [rancherdesktop.io](https://rancherdesktop.io) |
| kubectl | `kubectl version --client` | Bundled with Rancher Desktop, or `brew install kubectl` |
| helm v3 | `helm version` | `brew install helm` |
| Docker | `docker version` | Bundled with Rancher Desktop |

Verify kubeconfig is configured for Rancher Desktop:

```bash
kubectl config use-context rancher-desktop
kubectl config current-context
# Expected: rancher-desktop
```

---

## Stage 1 — Validate Cluster Readiness

### 1.1 Confirm cluster is reachable

```bash
kubectl get nodes
```

**Expected**: At least one node in `Ready` state.

```
NAME                   STATUS   ROLES                  AGE   VERSION
rancher-desktop        Ready    control-plane,master   Xd    v1.XX.X+k3s1
```

**If failed**: Rancher Desktop is not running or k3s is not enabled. Open Rancher Desktop → Preferences → Kubernetes → enable Kubernetes.

### 1.2 Confirm target namespace exists

```bash
make k8s-ns
# or manually:
kubectl get namespace brama 2>/dev/null || kubectl create namespace brama
```

**Expected**: Namespace `brama` shows `Active`.

### 1.3 Confirm no critical system pods are failing

```bash
kubectl get pods -A | grep -E "kube-system|cert-manager" | grep -v Running | grep -v Completed
```

**Expected**: No pods in `CrashLoopBackOff` or `Error` state in system namespaces.

---

## Stage 2 — Deploy the Platform

If not yet deployed, run the full setup:

```bash
make k8s-setup
# Equivalent to: k8s-build + k8s-load + k8s-secrets + k8s-deploy
```

Or individual steps:

```bash
make k8s-build      # Build Docker images locally
make k8s-load       # Import images into K3S via rdctl
make k8s-secrets    # Create brama-core-secrets in namespace brama
make k8s-deploy     # helm upgrade --install brama ...
```

---

## Stage 3 — Validate Infrastructure Layer

Check all pods in the `brama` namespace:

```bash
kubectl get pods -n brama -o wide
```

**Expected**: All pods `Running` or `Completed`.

### 3.1 PostgreSQL

```bash
# Check pod is running
kubectl get pods -n brama -l "app.kubernetes.io/name=postgresql"

# Test connectivity
kubectl exec -n brama -it \
  $(kubectl get pod -n brama -l "app.kubernetes.io/name=postgresql" -o jsonpath='{.items[0].metadata.name}') \
  -- psql -U app -d ai_community_platform -c "SELECT 1;"
```

**Expected**: `psql` returns `1` (query success).

**If failed**:
```bash
kubectl describe pod -n brama -l "app.kubernetes.io/name=postgresql"
kubectl logs -n brama -l "app.kubernetes.io/name=postgresql" --tail=50
```

### 3.2 Redis

```bash
# Check pod is running
kubectl get pods -n brama -l "app.kubernetes.io/name=redis"

# Test ping
kubectl exec -n brama -it \
  $(kubectl get pod -n brama -l "app.kubernetes.io/name=redis" -o jsonpath='{.items[0].metadata.name}') \
  -- redis-cli ping
```

**Expected**: `PONG`.

**If failed**:
```bash
kubectl logs -n brama -l "app.kubernetes.io/name=redis" --tail=50
```

### 3.3 RabbitMQ

```bash
# Check pod is running
kubectl get pods -n brama -l "app.kubernetes.io/name=rabbitmq"

# Check cluster status
kubectl exec -n brama -it \
  $(kubectl get pod -n brama -l "app.kubernetes.io/name=rabbitmq" -o jsonpath='{.items[0].metadata.name}') \
  -- rabbitmqctl status | grep "RabbitMQ"
```

**Expected**: RabbitMQ version line shown, no error.

**If failed**:
```bash
kubectl logs -n brama -l "app.kubernetes.io/name=rabbitmq" --tail=50
```

### 3.4 OpenSearch

> **Note**: OpenSearch is disabled in `values-k3s-dev.yaml` (`opensearch.enabled: false`).
> The platform uses Docker Compose's OpenSearch container when running locally.
> For k3s validation, this stage is **skipped**.

---

## Stage 4 — Validate Core Runtime

### 4.1 Confirm core pod is ready

```bash
kubectl get pods -n brama -l "app.kubernetes.io/component=core"
```

**Expected**: Pod status `Running`, `READY 1/1`.

**If not ready**:
```bash
kubectl describe pod -n brama -l "app.kubernetes.io/component=core"
kubectl logs -n brama -l "app.kubernetes.io/component=core" --tail=100
```

Common cause: `brama-core-secrets` Secret missing → run `make k8s-secrets`.

### 4.2 Validate health endpoint via exec

```bash
POD=$(kubectl get pod -n brama -l "app.kubernetes.io/component=core" \
  -o jsonpath='{.items[0].metadata.name}')

kubectl exec -n brama $POD -- curl -sf http://localhost/health
```

**Expected**:
```json
{"status":"ok","timestamp":"..."}
```

### 4.3 Validate operator-facing access via port-forward

```bash
kubectl port-forward -n brama svc/brama-core 8080:80 &

curl -sf http://localhost:8080/health
# or open in browser: http://core.localhost (requires /etc/hosts entry)
```

**Expected**: Health response returned.

To add the local DNS entry:
```bash
echo "127.0.0.1  core.localhost" | sudo tee -a /etc/hosts
```

Then access: `http://core.localhost` (Traefik routes based on `Host` header).

---

## Stage 5 — Validate Reference Agent Runtime

The reference agent in `values-k3s-dev.yaml` is **hello-agent** (`agents.hello.enabled: true`).

### 5.1 Confirm agent pod is ready

```bash
kubectl get pods -n brama -l "app.kubernetes.io/component=agent-hello"
```

**Expected**: Pod status `Running`, `READY 1/1`.

### 5.2 Validate agent health endpoint

```bash
AGENT_POD=$(kubectl get pod -n brama -l "app.kubernetes.io/component=agent-hello" \
  -o jsonpath='{.items[0].metadata.name}')

kubectl exec -n brama $AGENT_POD -- curl -sf http://localhost/health
```

**Expected**:
```json
{"status":"ok","service":"hello-agent","version":"0.1.0","timestamp":"..."}
```

### 5.3 Validate core-to-agent connectivity

The Kubernetes discovery provider reads agent Services with label `ai.platform.agent=true`.
Verify the agent Service has the expected labels:

```bash
kubectl get svc -n brama -l "ai.platform.agent=true"
```

**Expected**: `brama-agent-hello` service listed.

Verify core can reach the agent via the cluster DNS:

```bash
POD=$(kubectl get pod -n brama -l "app.kubernetes.io/component=core" \
  -o jsonpath='{.items[0].metadata.name}')

kubectl exec -n brama $POD -- curl -sf \
  http://brama-agent-hello.brama.svc.cluster.local/health
```

**Expected**: Health response from hello-agent.

---

## Quick Reference — Full Status Overview

```bash
make k8s-status
# Equivalent to:
kubectl get pods -n brama -o wide
kubectl get svc -n brama
kubectl get ingress -n brama
helm status brama -n brama
```

---

## Known Issues and Workarounds

| Issue | Cause | Fix |
|-------|-------|-----|
| `connection refused` on `kubectl get nodes` | Rancher Desktop not running | Start Rancher Desktop, wait for k3s to initialize (~1 min) |
| Pod stuck in `Pending` | No persistent volume storage | Rancher Desktop installs `local-path` provisioner — check `kubectl get storageclass` |
| `ImagePullBackOff` | Image not loaded into k3s containerd | `make k8s-load` to import images via `rdctl` |
| `CrashLoopBackOff` on core | Missing secrets | `make k8s-secrets` to recreate `brama-core-secrets` |
| `exec format error` | Wrong image architecture | Build on same-arch machine; Rancher Desktop on Apple Silicon needs arm64 images |
| Core not reachable at `core.localhost` | Missing `/etc/hosts` entry | `echo "127.0.0.1 core.localhost" \| sudo tee -a /etc/hosts` |
| `helm: Kubernetes cluster unreachable` | Wrong kubectl context | `kubectl config use-context rancher-desktop` |

---

## Minimum Re-validation Sequence

Run this sequence to verify the platform is healthy after any change:

```bash
# 1. Check context
kubectl config use-context rancher-desktop

# 2. Check cluster node
kubectl get nodes

# 3. Check all brama pods
kubectl get pods -n brama

# 4. Health-check core
kubectl exec -n brama \
  $(kubectl get pod -n brama -l "app.kubernetes.io/component=core" \
    -o jsonpath='{.items[0].metadata.name}') \
  -- curl -sf http://localhost/health

# 5. Health-check reference agent
kubectl exec -n brama \
  $(kubectl get pod -n brama -l "app.kubernetes.io/component=agent-hello" \
    -o jsonpath='{.items[0].metadata.name}') \
  -- curl -sf http://localhost/health

# 6. Verify agent discovery labels
kubectl get svc -n brama -l "ai.platform.agent=true"
```

All six steps passing = local k3s runtime is verified.
