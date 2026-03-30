# Local k3s Setup Runbook (Rancher Desktop)

> **Purpose**: Step-by-step guide to boot the Brama platform on local k3s using plain Kubernetes manifests.  
> **Cluster**: Rancher Desktop k3s (local machine)  
> **Namespace**: `brama`  
> **Manifests**: `deploy/k3s/`  
> **Relationship to Docker Compose**: This is an additive path — Docker Compose remains the primary local development runtime. k3s is used to validate Kubernetes manifests before production deployment.

---

## Prerequisites

### Rancher Desktop

| Requirement | Minimum | Notes |
|-------------|---------|-------|
| Rancher Desktop | 1.12.0+ | [rancherdesktop.io](https://rancherdesktop.io) |
| k3s (Kubernetes) | v1.28+ | Enable in Rancher Desktop → Preferences → Kubernetes |
| Container runtime | `containerd` | Required for k3s image loading via `rdctl` |
| CPU allocation | 4 cores | Rancher Desktop → Preferences → Virtual Machine |
| Memory allocation | 8 GB | Rancher Desktop → Preferences → Virtual Machine |

> **Apple Silicon (arm64)**: Rancher Desktop runs k3s in a VM. Images built locally are arm64 and work correctly. No cross-architecture issues for local k3s.

### Required CLI Tools

| Tool | Check | Install |
|------|-------|---------|
| `kubectl` | `kubectl version --client` | Bundled with Rancher Desktop |
| `helm` v3 | `helm version` | `brew install helm` (optional — only needed for Helm path) |
| `rdctl` | `rdctl version` | Bundled with Rancher Desktop |

### Verify Rancher Desktop Context

```bash
kubectl config use-context rancher-desktop
kubectl config current-context
# Expected: rancher-desktop

kubectl get nodes
# Expected: at least one node in Ready state
# NAME                   STATUS   ROLES                  AGE   VERSION
# rancher-desktop        Ready    control-plane,master   Xd    v1.XX.X+k3s1
```

---

## Directory Structure

All plain manifests live under `deploy/k3s/` in the workspace root:

```
deploy/k3s/
├── kustomization.yaml          ← apply all resources at once
├── namespace/
│   └── namespace.yaml          ← brama namespace with shared labels
├── config/
│   ├── configmap.yaml          ← brama-config (non-secret values)
│   └── secret.yaml             ← brama-secrets (credentials)
├── infra/
│   ├── postgres/               ← PostgreSQL (pgvector/pgvector:pg16)
│   │   ├── pvc.yaml
│   │   ├── deployment.yaml
│   │   └── service.yaml
│   ├── redis/                  ← Redis (redis:7-alpine)
│   │   ├── pvc.yaml
│   │   ├── deployment.yaml
│   │   └── service.yaml
│   ├── rabbitmq/               ← RabbitMQ (rabbitmq:3.13-management-alpine)
│   │   ├── pvc.yaml
│   │   ├── deployment.yaml
│   │   └── service.yaml
│   └── opensearch/             ← OpenSearch (opensearchproject/opensearch:2.11.1)
│       ├── pvc.yaml
│       ├── deployment.yaml
│       └── service.yaml
├── core/
│   ├── deployment.yaml         ← core runtime with readiness/liveness probes
│   └── service.yaml
├── agents/
│   └── hello-agent/
│       ├── deployment.yaml     ← reference agent (ghcr.io/nmdimas/a2a-hello-agent:main)
│       └── service.yaml
└── ingress/
    └── ingress.yaml            ← optional Traefik Ingress
```

---

## Stage 1 — Namespace Setup

### 1.1 Set the correct kube context

```bash
kubectl config use-context rancher-desktop
kubectl config current-context
# Expected: rancher-desktop
```

### 1.2 Create the namespace

```bash
kubectl apply -f deploy/k3s/namespace/namespace.yaml
kubectl get namespace brama
# Expected: brama   Active   Xs
```

Verify the label:

```bash
kubectl get namespace brama --show-labels
# Expected: app.kubernetes.io/part-of=brama
```

---

## Stage 2 — Shared Config and Secrets

### 2.1 Apply ConfigMap and Secret

```bash
kubectl apply -f deploy/k3s/config/configmap.yaml
kubectl apply -f deploy/k3s/config/secret.yaml
```

Verify:

```bash
kubectl get configmap brama-config -n brama
kubectl get secret brama-secrets -n brama
```

> **Security note**: The `secret.yaml` file contains development-only placeholder values. For any non-local environment, replace values in `secret.yaml` or use `kubectl create secret generic` with real values. Never commit real credentials.

### 2.2 ConfigMap / Secret mapping from `.env.deployment.example`

See [ConfigMap and Secret Strategy](#configmap-and-secret-strategy) section below for the full mapping table.

---

## Stage 3 — Infrastructure Services

Apply all infrastructure manifests:

```bash
kubectl apply -f deploy/k3s/infra/postgres/
kubectl apply -f deploy/k3s/infra/redis/
kubectl apply -f deploy/k3s/infra/rabbitmq/
kubectl apply -f deploy/k3s/infra/opensearch/
```

Wait for pods to reach `Running` state (up to 120 seconds):

```bash
kubectl get pods -n brama -l app.kubernetes.io/component=infra -w
```

### 3.1 Verify PostgreSQL

```bash
kubectl exec -n brama \
  $(kubectl get pod -n brama -l app.kubernetes.io/name=postgres -o jsonpath='{.items[0].metadata.name}') \
  -- pg_isready -U app
# Expected: /var/run/postgresql:5432 - accepting connections
```

### 3.2 Verify Redis

```bash
kubectl exec -n brama \
  $(kubectl get pod -n brama -l app.kubernetes.io/name=redis -o jsonpath='{.items[0].metadata.name}') \
  -- redis-cli ping
# Expected: PONG
```

### 3.3 Verify RabbitMQ

```bash
kubectl exec -n brama \
  $(kubectl get pod -n brama -l app.kubernetes.io/name=rabbitmq -o jsonpath='{.items[0].metadata.name}') \
  -- rabbitmq-diagnostics -q ping
# Expected: Ping succeeded if node is up
```

### 3.4 Verify OpenSearch

```bash
kubectl exec -n brama \
  $(kubectl get pod -n brama -l app.kubernetes.io/name=opensearch -o jsonpath='{.items[0].metadata.name}') \
  -- curl -sf http://localhost:9200
# Expected: JSON response with cluster_name, version, etc.
```

> **Note on OpenSearch**: The deployment includes an init container that sets `vm.max_map_count=262144`. Rancher Desktop's VM typically handles this automatically, but the init container ensures it is set regardless.

---

## Stage 4 — Core Runtime

### 4.1 Build and load the core image

```bash
# Build the core image
docker build -t brama/core:dev -f brama-core/Dockerfile brama-core

# Load into Rancher Desktop k3s containerd
docker save brama/core:dev | rdctl shell sudo k3s ctr images import -
```

### 4.2 Apply core manifests

```bash
kubectl apply -f deploy/k3s/core/
```

### 4.3 Verify core is ready

```bash
kubectl get pods -n brama -l app.kubernetes.io/component=core -w
# Wait for: READY 1/1, STATUS Running
```

### 4.4 Verify health endpoint

```bash
kubectl exec -n brama \
  $(kubectl get pod -n brama -l app.kubernetes.io/name=core -o jsonpath='{.items[0].metadata.name}') \
  -- curl -sf http://localhost/health
# Expected: {"status":"ok","service":"core-platform",...}
```

### 4.5 Verify cluster DNS

The core service is resolvable as `core.brama.svc.cluster.local`:

```bash
kubectl exec -n brama \
  $(kubectl get pod -n brama -l app.kubernetes.io/name=core -o jsonpath='{.items[0].metadata.name}') \
  -- curl -sf http://core.brama.svc.cluster.local/health
```

---

## Stage 5 — Reference Agent (hello-agent)

### 5.1 Apply hello-agent manifests

```bash
kubectl apply -f deploy/k3s/agents/hello-agent/
```

### 5.2 Verify hello-agent is ready

```bash
kubectl get pods -n brama -l app.kubernetes.io/name=hello-agent -w
# Wait for: READY 1/1, STATUS Running
```

### 5.3 Verify hello-agent health endpoint

```bash
kubectl exec -n brama \
  $(kubectl get pod -n brama -l app.kubernetes.io/name=hello-agent -o jsonpath='{.items[0].metadata.name}') \
  -- curl -sf http://localhost/health
# Expected: {"status":"ok","service":"hello-agent",...}
```

### 5.4 Verify core-to-agent connectivity

```bash
kubectl exec -n brama \
  $(kubectl get pod -n brama -l app.kubernetes.io/name=core -o jsonpath='{.items[0].metadata.name}') \
  -- curl -sf http://hello-agent.brama.svc.cluster.local/health
# Expected: health response from hello-agent
```

---

## Stage 6 — Operator Access

### 6.1 Port-forward commands

Use `kubectl port-forward` to access services from your local machine:

```bash
# Core platform (http://localhost:8081/health)
kubectl port-forward svc/core 8081:80 -n brama

# PostgreSQL (localhost:5432)
kubectl port-forward svc/postgres 5432:5432 -n brama

# Redis (localhost:6379)
kubectl port-forward svc/redis 6379:6379 -n brama

# RabbitMQ management UI (http://localhost:15672)
kubectl port-forward svc/rabbitmq 15672:15672 -n brama

# OpenSearch (http://localhost:9200)
kubectl port-forward svc/opensearch 9200:9200 -n brama

# Hello-agent (http://localhost:8082/health)
kubectl port-forward svc/hello-agent 8082:80 -n brama
```

Run multiple port-forwards in the background:

```bash
kubectl port-forward svc/core 8081:80 -n brama &
kubectl port-forward svc/postgres 5432:5432 -n brama &
kubectl port-forward svc/redis 6379:6379 -n brama &
kubectl port-forward svc/rabbitmq 15672:15672 -n brama &
kubectl port-forward svc/opensearch 9200:9200 -n brama &
```

Stop all port-forwards:

```bash
pkill -f "kubectl port-forward"
```

### 6.2 Optional Traefik Ingress (hostname-based routing)

Rancher Desktop includes Traefik as the default ingress controller. To use hostname-based routing:

**Step 1** — Add entries to `/etc/hosts`:

```bash
echo "127.0.0.1  brama.localhost" | sudo tee -a /etc/hosts
echo "127.0.0.1  hello.brama.localhost" | sudo tee -a /etc/hosts
```

**Step 2** — Apply the Ingress manifest:

```bash
kubectl apply -f deploy/k3s/ingress/ingress.yaml
```

**Step 3** — Verify:

```bash
kubectl get ingress -n brama
# Expected: brama-ingress with hosts brama.localhost, hello.brama.localhost

curl -sf http://brama.localhost/health
curl -sf http://hello.brama.localhost/health
```

> **Note**: Traefik Ingress requires `/etc/hosts` entries on macOS/Linux. On Windows, edit `C:\Windows\System32\drivers\etc\hosts`.

---

## Apply Everything at Once (Kustomize)

To apply all resources in the correct order:

```bash
kubectl apply -k deploy/k3s/
```

To delete all resources:

```bash
kubectl delete -k deploy/k3s/
# or to remove the entire namespace:
kubectl delete namespace brama
```

---

## ConfigMap and Secret Strategy

### Rationale

The `.env.deployment.example` file defines all runtime configuration for the platform. In Kubernetes, this is split into two resources:

- **`ConfigMap/brama-config`** — non-secret runtime values (hostnames, ports, URLs, feature flags). Safe to inspect with `kubectl get configmap`.
- **`Secret/brama-secrets`** — credentials and sensitive values (passwords, API keys, JWT secrets). Stored as Kubernetes Secrets (base64-encoded, access-controlled).

Services reference both via `envFrom`:

```yaml
envFrom:
  - configMapRef:
      name: brama-config
  - secretRef:
      name: brama-secrets
```

This mirrors the `.env.deployment` model that already works for Docker Compose, making the mapping auditable and the transition to Helm values straightforward.

### Mapping Table

| `.env.deployment.example` variable | k3s resource | Key |
|------------------------------------|--------------|-----|
| `POSTGRES_HOST` | ConfigMap | `POSTGRES_HOST` |
| `POSTGRES_PORT` | ConfigMap | `POSTGRES_PORT` |
| `POSTGRES_DB` | ConfigMap | `POSTGRES_DB` |
| `DATABASE_URL` | ConfigMap | `DATABASE_URL` |
| `POSTGRES_PROVISIONER_URL` | ConfigMap | `POSTGRES_PROVISIONER_URL` |
| `POSTGRES_USER` | **Secret** | `POSTGRES_USER` |
| `POSTGRES_PASSWORD` | **Secret** | `POSTGRES_PASSWORD` |
| `REDIS_HOST` | ConfigMap | `REDIS_HOST` |
| `REDIS_PORT` | ConfigMap | `REDIS_PORT` |
| `REDIS_URL` | ConfigMap | `REDIS_URL` |
| `OPENSEARCH_HOST` | ConfigMap | `OPENSEARCH_HOST` |
| `OPENSEARCH_PORT` | ConfigMap | `OPENSEARCH_PORT` |
| `OPENSEARCH_URL` | ConfigMap | `OPENSEARCH_URL` |
| `RABBITMQ_HOST` | ConfigMap | `RABBITMQ_HOST` |
| `RABBITMQ_PORT` | ConfigMap | `RABBITMQ_PORT` |
| `RABBITMQ_USER` | **Secret** | `RABBITMQ_USER` |
| `RABBITMQ_PASSWORD` | **Secret** | `RABBITMQ_PASSWORD` |
| `RABBITMQ_URL` | **Secret** | `RABBITMQ_URL` |
| `LITELLM_HOST` | ConfigMap | `LITELLM_HOST` |
| `LITELLM_PORT` | ConfigMap | `LITELLM_PORT` |
| `LITELLM_BASE_URL` | ConfigMap | `LITELLM_BASE_URL` |
| `LITELLM_API_KEY` | **Secret** | `LITELLM_API_KEY` |
| `LANGFUSE_HOST` | ConfigMap | `LANGFUSE_HOST` |
| `LANGFUSE_PORT` | ConfigMap | `LANGFUSE_PORT` |
| `LANGFUSE_BASE_URL` | ConfigMap | `LANGFUSE_BASE_URL` |
| `LANGFUSE_ENV` | ConfigMap | `LANGFUSE_ENV` |
| `LANGFUSE_ENABLED` | ConfigMap | `LANGFUSE_ENABLED` |
| `LANGFUSE_PUBLIC_KEY` | **Secret** | `LANGFUSE_PUBLIC_KEY` |
| `LANGFUSE_SECRET_KEY` | **Secret** | `LANGFUSE_SECRET_KEY` |
| `EDGE_AUTH_JWT_SECRET` | **Secret** | `EDGE_AUTH_JWT_SECRET` |
| `EDGE_AUTH_COOKIE_NAME` | ConfigMap | `EDGE_AUTH_COOKIE_NAME` |
| `EDGE_AUTH_TOKEN_TTL` | ConfigMap | `EDGE_AUTH_TOKEN_TTL` |
| `EDGE_AUTH_LOGIN_BASE_URL` | ConfigMap | `EDGE_AUTH_LOGIN_BASE_URL` |
| `EDGE_AUTH_COOKIE_DOMAIN` | ConfigMap | `EDGE_AUTH_COOKIE_DOMAIN` |
| `TURNSTILE_ENABLED` | ConfigMap | `TURNSTILE_ENABLED` |
| `TURNSTILE_SITE_KEY` | ConfigMap | `TURNSTILE_SITE_KEY` |
| `TURNSTILE_SECRET_KEY` | **Secret** | `TURNSTILE_SECRET_KEY` |
| `APP_INTERNAL_TOKEN` | **Secret** | `APP_INTERNAL_TOKEN` |

---

## Relationship to Docker Compose Runtime

| Aspect | Docker Compose | Local k3s (this guide) |
|--------|---------------|------------------------|
| Primary use | Local development | Kubernetes manifest validation |
| Boot time | ~30 seconds | ~2–5 minutes |
| Image source | Local build | Local build + `rdctl` import |
| Config source | `.env.local` + `.env.deployment` | `ConfigMap/brama-config` + `Secret/brama-secrets` |
| Networking | Docker bridge network | Kubernetes cluster DNS |
| Storage | Docker volumes | k3s `local-path` PVCs |
| Ingress | Traefik container | Traefik (built into k3s) |
| Teardown | `docker compose down` | `kubectl delete namespace brama` |

**Rule of thumb**: Use Docker Compose for day-to-day development. Use local k3s to validate that manifests work before deploying to the Hetzner production cluster.

---

## Known Gaps and Workarounds

| Gap | Status | Workaround |
|-----|--------|------------|
| LiteLLM not deployed | Out of scope for this change | Use Docker Compose for LiteLLM-dependent features |
| Langfuse not deployed | Out of scope for this change | Use Docker Compose for Langfuse-dependent features |
| OpenClaw not deployed | Out of scope for this change | Use Docker Compose for OpenClaw-dependent features |
| Core image must be built locally | No CI push to local k3s | `docker build` + `rdctl` import (see Stage 4) |
| Database migrations not automated | No migration Job yet | Run `make migrate` against port-forwarded PostgreSQL |
| `secret.yaml` contains dev placeholders | Local dev only | Replace values for any non-local environment |

---

## Known Issues

| Issue | Cause | Fix |
|-------|-------|-----|
| `connection refused` on `kubectl get nodes` | Rancher Desktop not running | Start Rancher Desktop, wait ~1 min for k3s |
| Pod stuck in `Pending` | No storage provisioner | Check `kubectl get storageclass` — `local-path` must exist |
| `ImagePullBackOff` on core | Image not loaded into k3s | `docker save brama/core:dev \| rdctl shell sudo k3s ctr images import -` |
| OpenSearch pod `CrashLoopBackOff` | `vm.max_map_count` too low | Init container handles this; if it fails, run `rdctl shell sudo sysctl -w vm.max_map_count=262144` |
| `helm: Kubernetes cluster unreachable` | Wrong kubectl context | `kubectl config use-context rancher-desktop` |
| Port-forward drops after idle | TCP keepalive timeout | Re-run the port-forward command |

---

## Quick Reference — Full Status Check

```bash
# Context
kubectl config current-context

# All brama pods
kubectl get pods -n brama -o wide

# All brama services
kubectl get svc -n brama

# Infra pods only
kubectl get pods -n brama -l app.kubernetes.io/component=infra

# Core health
kubectl exec -n brama \
  $(kubectl get pod -n brama -l app.kubernetes.io/name=core -o jsonpath='{.items[0].metadata.name}') \
  -- curl -sf http://localhost/health

# Hello-agent health
kubectl exec -n brama \
  $(kubectl get pod -n brama -l app.kubernetes.io/name=hello-agent -o jsonpath='{.items[0].metadata.name}') \
  -- curl -sf http://localhost/health
```
