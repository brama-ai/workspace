# Deploying an Agent to Kubernetes (K3S)

> **Validated against**: hello-agent deployment on 2026-03-24  
> **Cluster**: K3S v1.34.5+k3s1 @ 46.62.135.86  
> **Namespace**: `brama`  
> **Log**: `setup-agent.log` (root of workspace)

---

## Overview

The platform uses a **Helm umbrella chart** (`brama-core/deploy/charts/brama`) to manage all services including agents. Each agent is defined in `values-k3s-dev.yaml` under the `agents:` key.

```
brama-core/deploy/charts/brama/
├── Chart.yaml
├── Chart.lock
├── charts/                    ← sub-charts (postgresql, redis, rabbitmq)
├── templates/
│   ├── agents/
│   │   ├── deployment.yaml    ← iterates over .Values.agents
│   │   └── service.yaml
│   ├── core/
│   └── ingress.yaml
├── values.yaml                ← defaults
├── values-k3s-dev.yaml        ← dev/staging overrides (used for deploy)
└── values-prod.example.yaml   ← production template
```

---

## Prerequisites

| Tool | Where | Notes |
|------|-------|-------|
| `kubectl` | server | configured via `KUBECONFIG=/etc/rancher/k3s/k3s.yaml` |
| `helm` v3 | server | `helm version` |
| `nerdctl` | server | for building images without Docker |
| `buildkitd` | server | used by nerdctl for builds |
| `k3s ctr` | server | K3S containerd CLI |
| SSH access | local | key: `~/.ssh/ai_platform` |

---

## Domain Configuration (Cloudflare Tunnel)

The cluster is exposed to the internet via **Cloudflare Tunnel** (no open ports required). Traffic flows:

```
Internet → Cloudflare Tunnel (cloudflared) → Traefik :80 → K3s Services
```

### Step D1 — Configure Cloudflare Tunnel routes

In **Cloudflare Zero Trust → Networks → Tunnels → brama → Public Hostnames**, add:

| Subdomain | Domain | Service | Notes |
|-----------|--------|---------|-------|
| (empty) | `brama.dev` | `http://localhost:80` | Core platform |
| `hello` | `brama.dev` | `http://localhost:80` | Hello agent |

> All routes point to `localhost:80` — Traefik routes internally by `Host` header.

### Step D2 — Update Helm ingress hosts

The ingress `hosts.core` value must match the public domain. Create an override file:

```bash
# On server
cat > /tmp/values-domain.yaml << 'EOF'
ingress:
  enabled: true
  className: traefik
  hosts:
    core: brama.dev
  tls:
    enabled: false
  annotations:
    traefik.ingress.kubernetes.io/router.entrypoints: web
EOF
```

Then apply with Helm upgrade:

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

helm upgrade brama /tmp/brama-deploy/brama \
  --namespace brama \
  -f /tmp/brama-deploy/brama/values-k3s-dev.yaml \
  -f /tmp/values-domain.yaml \
  --timeout 3m
```

Verify the ingress picked up the new host:

```bash
kubectl get ingress -n brama
# Expected: HOSTS = brama.dev, ADDRESS = 46.62.135.86
```

### Step D3 — Add agent ingress routes

By default only `core` has an ingress rule. To expose agents, add rules manually or extend `ingress.yaml`. Quick manual approach:

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

kubectl apply -f - << 'EOF'
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: brama-agents
  namespace: brama
  annotations:
    traefik.ingress.kubernetes.io/router.entrypoints: web
spec:
  ingressClassName: traefik
  rules:
    - host: hello.brama.dev
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: brama-agent-hello
                port:
                  number: 80
EOF
```

### Step D4 — Verify end-to-end

```bash
# Core platform
curl -sf https://brama.dev/health
# Expected: {"status":"ok",...}

# Hello agent
curl -sf https://hello.brama.dev/health
# Expected: {"status":"ok","service":"hello-agent",...}
```

> **Note**: Cloudflare Tunnel handles TLS automatically — no cert management needed on the server side.

---

## Step-by-Step Deployment

### Step 0 — Pre-deploy check

Before deploying, verify the current cluster state:

```bash
# On server (SSH in first)
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# Check cluster is healthy
kubectl get nodes

# Check current pods
kubectl get pods -n brama

# Check current Helm release
helm list -n brama
helm history brama -n brama

# Document rollback revision BEFORE deploying
# e.g., if current revision is 5, rollback target is 5
```

### Step 1 — Build the Docker image

> **IMPORTANT**: If your devcontainer is `arm64` (Apple Silicon) and the server is `amd64`, you **cannot** build locally and transfer the image. Build on the server instead (Step 1b).

#### Step 1a — Build locally (same architecture)

```bash
# From workspace root
docker build -t brama/hello-agent:dev brama-agents/hello-agent/

# Verify architecture matches server
docker inspect brama/hello-agent:dev --format '{{.Architecture}}'
# Must be: amd64
```

#### Step 1b — Build on server (cross-architecture fix)

Use this when devcontainer is `arm64` and server is `amd64`:

```bash
# 1. Pack source code
tar czf /tmp/hello-agent-src.tar.gz -C brama-agents/hello-agent .

# 2. Transfer to server
scp -i ~/.ssh/ai_platform \
    -o StrictHostKeyChecking=no \
    -F /dev/null \
    -o IdentitiesOnly=yes \
    /tmp/hello-agent-src.tar.gz root@46.62.135.86:/tmp/

# 3. On server — extract and build
ssh -i ~/.ssh/ai_platform -F /dev/null root@46.62.135.86 << 'EOF'
  mkdir -p /tmp/hello-agent-build
  tar xzf /tmp/hello-agent-src.tar.gz -C /tmp/hello-agent-build

  # Build with nerdctl (uses buildkitd, native amd64)
  nerdctl --namespace k8s.io build \
    -t brama/hello-agent:dev \
    /tmp/hello-agent-build/

  # Import into K3S containerd
  nerdctl --namespace k8s.io save brama/hello-agent:dev \
    | k3s ctr images import -

  # Verify image is imported
  k3s ctr images ls | grep hello-agent
EOF
```

Expected output:
```
docker.io/brama/hello-agent:dev   ...   215.3 MiB   linux/amd64   ...
```

### Step 2 — Transfer the Helm chart

```bash
# Pack the chart
tar czf /tmp/brama-chart.tar.gz -C brama-core/deploy/charts brama

# Transfer to server
scp -i ~/.ssh/ai_platform \
    -o StrictHostKeyChecking=no \
    -F /dev/null \
    -o IdentitiesOnly=yes \
    /tmp/brama-chart.tar.gz root@46.62.135.86:/tmp/

# On server — extract
ssh -i ~/.ssh/ai_platform -F /dev/null root@46.62.135.86 << 'EOF'
  mkdir -p /tmp/brama-deploy
  tar xzf /tmp/brama-chart.tar.gz -C /tmp/brama-deploy
  ls /tmp/brama-deploy/brama/
EOF
```

### Step 3 — Run Helm upgrade

```bash
# On server
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

helm upgrade --install brama /tmp/brama-deploy/brama \
  --namespace brama \
  -f /tmp/brama-deploy/brama/values-k3s-dev.yaml \
  --wait --timeout 5m
```

If `--wait` times out (e.g., due to SSH timeout), check status manually:

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
helm list -n brama
kubectl get pods -n brama
```

If the pod is in `CrashLoopBackOff` after upgrade, restart the deployment to force it to pull the new image from containerd:

```bash
kubectl rollout restart deployment/brama-agent-hello -n brama
kubectl rollout status deployment/brama-agent-hello -n brama --timeout=3m
```

### Step 4 — Health check

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# Get pod name
POD=$(kubectl get pod -n brama -l "app.kubernetes.io/component=agent-hello" \
  -o jsonpath='{.items[0].metadata.name}')

# Health check
kubectl exec -n brama $POD -- curl -sf http://localhost/health

# Expected response:
# {"status":"ok","service":"hello-agent","version":"0.1.0","timestamp":"..."}
```

---

## Adding a New Agent

To deploy a new agent, add it to `values-k3s-dev.yaml`:

```yaml
agents:
  hello:
    enabled: true
    image:
      repository: brama/hello-agent
      tag: "dev"
      pullPolicy: IfNotPresent
    replicaCount: 1
    service:
      port: 80
    readinessProbe:
      httpGet:
        path: /health
        port: 80
      initialDelaySeconds: 10
      periodSeconds: 10
    livenessProbe:
      httpGet:
        path: /health
        port: 80
      initialDelaySeconds: 30
      periodSeconds: 30
    resources:
      requests:
        cpu: 50m
        memory: 64Mi
      limits:
        cpu: 250m
        memory: 128Mi

  # Add your new agent here:
  myNewAgent:
    enabled: true
    image:
      repository: brama/my-new-agent
      tag: "dev"
      pullPolicy: IfNotPresent
    replicaCount: 1
    service:
      port: 80
    readinessProbe:
      httpGet:
        path: /health
        port: 80
      initialDelaySeconds: 10
      periodSeconds: 10
    livenessProbe:
      httpGet:
        path: /health
        port: 80
      initialDelaySeconds: 30
      periodSeconds: 30
    resources:
      requests:
        cpu: 50m
        memory: 64Mi
      limits:
        cpu: 250m
        memory: 128Mi
```

The Helm templates in `templates/agents/deployment.yaml` and `templates/agents/service.yaml` automatically iterate over all enabled agents.

---

## Rollback

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# List revisions
helm history brama -n brama

# Roll back to previous revision
helm rollback brama <REVISION_NUMBER> -n brama

# Verify rollout
kubectl rollout status deployment/brama-agent-hello -n brama

# Health check
POD=$(kubectl get pod -n brama -l "app.kubernetes.io/component=agent-hello" \
  -o jsonpath='{.items[0].metadata.name}')
kubectl exec -n brama $POD -- curl -sf http://localhost/health
```

---

## Useful Commands

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

# Status overview
kubectl get pods -n brama
kubectl get svc -n brama
kubectl get ingress -n brama
helm list -n brama

# Logs
kubectl logs -n brama -l "app.kubernetes.io/component=agent-hello" --tail=50

# Shell into pod
kubectl exec -it -n brama \
  $(kubectl get pod -n brama -l "app.kubernetes.io/component=agent-hello" \
    -o jsonpath='{.items[0].metadata.name}') -- bash

# Check images in K3S containerd
k3s ctr images ls | grep brama

# Helm diff (requires helm-diff plugin)
helm diff upgrade brama /tmp/brama-deploy/brama \
  --namespace brama \
  -f /tmp/brama-deploy/brama/values-k3s-dev.yaml
```

---

## Makefile Shortcuts (from workspace root)

```bash
# Full setup: build + load + secrets + deploy (local K3S only)
make k8s-setup

# Build images
make k8s-build

# Load images into K3S
make k8s-load

# Deploy/upgrade Helm chart
make k8s-deploy

# Check status
make k8s-status

# Follow logs
make k8s-logs svc=agent-hello

# Open shell
make k8s-shell svc=agent-hello

# Destroy
make k8s-destroy
```

> **Note**: `make k8s-build` and `make k8s-load` use `rdctl` (Rancher Desktop) for local K3S.  
> For remote K3S servers, use the manual steps in this guide.

---

## Known Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| `exec format error` | Image built for wrong arch (arm64 vs amd64) | Build on server with `nerdctl` (Step 1b) |
| `helm upgrade` timeout | `--wait` exceeds SSH timeout | Run in background, check status manually |
| Pod stuck in `CrashLoopBackOff` after upgrade | Old image cached in containerd | `kubectl rollout restart deployment/<name> -n brama` |
| `helm: Kubernetes cluster unreachable` | Missing `KUBECONFIG` | `export KUBECONFIG=/etc/rancher/k3s/k3s.yaml` |

---

## SSH Config Note

The SSH config at `~/.ssh/config` may contain macOS-specific options (`UseKeychain`) that cause errors on Linux. Use `-F /dev/null` to bypass it:

```bash
ssh -i ~/.ssh/ai_platform -F /dev/null -o IdentitiesOnly=yes root@46.62.135.86
scp -i ~/.ssh/ai_platform -F /dev/null -o IdentitiesOnly=yes <src> root@46.62.135.86:<dst>
```

---

*This document was generated from `setup-agent.log` — the live deployment log of hello-agent on 2026-03-24.*
