# Pipeline Handoff

- **Task**: <!-- priority: 1 -->
# Configure production domains for external services (Langfuse, LiteLLM, OpenClaw)

Set up proper domain configuration and edge authentication for external admin services on production K3S server (46.62.135.86).

## Goal

Configure and verify that Langfuse, LiteLLM, and OpenClaw are accessible via proper domains with edge authentication protection on the production server.

## Context

### Current State (Docker Compose - Local Development)

External services are accessible via subdomains:
- **Langfuse**: `langfuse.brama.localhost` / `langfuse.localhost`
- **LiteLLM**: `litellm.brama.localhost` / `litellm.localhost`
- **OpenClaw**: `openclaw.brama.localhost` / `openclaw.localhost`
- **Traefik Dashboard**: `traefik.brama.localhost` / `traefik.localhost`

All protected with `edge-auth@docker` middleware via Traefik (see `docker/compose.langfuse.yaml:52`, `docker/compose.yaml:150`, `docker/compose.openclaw.yaml:25`).

### Edge Authentication Mechanism

**How it works:**
1. Traefik intercepts requests to protected services
2. ForwardAuth middleware sends verification request to `http://brama-core/edge/auth/verify`
3. JWT token validation from cookie `ACP_EDGE_TOKEN`
4. If invalid → redirect to login page on same subdomain
5. If valid → allow access (HTTP 204)

**Configuration files:**
- Edge auth middleware definition: `docker/compose.core.yaml:16-18`
- JWT service: `brama-core/src/src/EdgeAuth/EdgeJwtService.php`
- Verify controller: `brama-core/src/src/Controller/EdgeAuth/VerifyController.php`
- Login controller: `brama-core/src/src/Controller/EdgeAuth/LoginController.php`

**Environment variables:**
```bash
EDGE_AUTH_JWT_SECRET=dev-edge-auth-secret-change-me  # ⚠️ Change in production!
EDGE_AUTH_COOKIE_NAME=ACP_EDGE_TOKEN
EDGE_AUTH_TOKEN_TTL=43200  # 12 hours
EDGE_AUTH_LOGIN_BASE_URL=http://${PUBLIC_DOMAIN}
EDGE_AUTH_COOKIE_DOMAIN=${PUBLIC_DOMAIN}
```

### Production Domain Strategy

**Option 1: Using nip.io (current approach in values-remote.yaml)**
- Core: `46.62.135.86.nip.io`
- Langfuse: `langfuse.46.62.135.86.nip.io`
- LiteLLM: `litellm.46.62.135.86.nip.io`
- OpenClaw: `openclaw.46.62.135.86.nip.io`

**Option 2: Real domain (production-ready)**
- Core: `platform.example.com`
- Langfuse: `langfuse.example.com`
- LiteLLM: `litellm.example.com`
- OpenClaw: `openclaw.example.com`

## Files to Modify/Create

### 1. Helm Chart Configuration

**Update ingress configuration:**
- `brama-core/deploy/charts/brama/templates/ingress.yaml` - add routes for Langfuse, OpenClaw
- `brama-core/deploy/charts/brama/values-k3s-dev.yaml` - update ingress.hosts section
- Create `brama-core/deploy/charts/brama/values-k3s-production.yaml` with production domains

**Example ingress.hosts structure:**
```yaml
ingress:
  enabled: true
  className: traefik
  hosts:
    core: 46.62.135.86.nip.io
    langfuse: langfuse.46.62.135.86.nip.io
    litellm: litellm.46.62.135.86.nip.io
    openclaw: openclaw.46.62.135.86.nip.io
  tls:
    enabled: false  # Start without TLS, add later
  annotations:
    # Edge auth middleware annotations
    traefik.ingress.kubernetes.io/router.middlewares: brama-edge-auth@kubernetescrd
```

### 2. Kubernetes Middleware for Edge Auth

Create `brama-core/deploy/charts/brama/templates/edge-auth-middleware.yaml`:
```yaml
apiVersion: traefik.containo.us/v1alpha1
kind: Middleware
metadata:
  name: edge-auth
  namespace: {{ .Release.Namespace }}
spec:
  forwardAuth:
    address: http://{{ include "acp.fullname" . }}-core/edge/auth/verify
    trustForwardHeader: true
    authResponseHeaders:
      - X-Forwarded-User
```

### 3. Core Service Environment Variables

Update `brama-core/deploy/charts/brama/values-k3s-production.yaml`:
```yaml
core:
  env:
    EDGE_AUTH_COOKIE_DOMAIN: ".46.62.135.86.nip.io"
    EDGE_AUTH_LOGIN_BASE_URL: "http://46.62.135.86.nip.io"
    ADMIN_LANGFUSE_URL: "http://langfuse.46.62.135.86.nip.io/"
    ADMIN_LITELLM_URL: "http://litellm.46.62.135.86.nip.io/"
    ADMIN_OPENCLAW_URL: "http://openclaw.46.62.135.86.nip.io/"
```

### 4. External Services Deployment

These services are NOT yet deployed to K3S. Need to:
- Create Helm sub-charts or standalone deployments for:
  - Langfuse (with Postgres, Redis, ClickHouse, MinIO dependencies)
  - LiteLLM (with database)
  - OpenClaw (with OpenSearch)

**OR** keep them in Docker Compose on the same server and proxy via Traefik.

## Implementation Steps

### Step 1: Research Deployment Strategy

**Decision needed:** Should Langfuse, LiteLLM, OpenClaw be:
- A) Deployed as K8S services (complex, more dependencies)
- B) Run as Docker Compose on same server, exposed via Traefik ingress to K3S
- C) Run on separate server and proxy via Traefik

**Recommended: Option B** - simplest for now.

### Step 2: Verify Current K3S Ingress

```bash
# On server
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
kubectl get ingress -n brama
kubectl describe ingress -n brama
```

### Step 3: Create Edge Auth Middleware in K8S

Deploy `edge-auth-middleware.yaml` to the cluster.

### Step 4: Update Helm Values for Production

Create `values-k3s-production.yaml` with proper domains.

### Step 5: Deploy and Test

```bash
# Update Helm chart
helm upgrade --install brama /tmp/brama-deploy/brama \
  --namespace brama \
  -f /tmp/brama-deploy/brama/values-k3s-production.yaml \
  --wait --timeout 5m

# Verify ingress
kubectl get ingress -n brama -o yaml

# Test edge auth
curl -v http://langfuse.46.62.135.86.nip.io/
# Should redirect to login
```

### Step 6: Document Configuration

Create `docs/production-domains-setup.md` with:
- Domain mapping table
- DNS configuration steps (if using real domain)
- Edge auth verification steps
- Troubleshooting guide

## Validation Checklist

- [ ] Edge auth middleware deployed to K3S
- [ ] Ingress routes created for all external services
- [ ] Core service has correct ADMIN_*_URL environment variables
- [ ] `curl http://langfuse.46.62.135.86.nip.io/` redirects to login
- [ ] After login, can access Langfuse UI
- [ ] After login, can access LiteLLM UI
- [ ] After login, can access OpenClaw UI
- [ ] Edge auth cookie is set correctly for each subdomain
- [ ] Documentation created in `docs/production-domains-setup.md`

## References

### Docker Compose Configuration
- `docker/compose.langfuse.yaml` - Langfuse service + edge-auth
- `docker/compose.yaml` - LiteLLM + Traefik dashboard + edge-auth
- `docker/compose.openclaw.yaml` - OpenClaw + edge-auth (with webhook bypass)
- `docker/compose.core.yaml` - Core + edge-auth middleware definition

### Helm Configuration
- `brama-core/deploy/charts/brama/templates/ingress.yaml` - Current ingress template
- `brama-core/deploy/charts/brama/values-prod.example.yaml` - Production example (lines 82-86 show ingress.hosts)
- `values-remote.yaml` - Current remote deployment config (line 187: `core: 46.62.135.86.nip.io`)

### Edge Auth Implementation
- `brama-core/src/src/EdgeAuth/EdgeJwtService.php` - JWT creation/validation
- `brama-core/src/src/Controller/EdgeAuth/VerifyController.php` - Auth verification endpoint
- `brama-core/src/src/Controller/EdgeAuth/LoginController.php` - Login form + token creation
- `.env.deployment.example:92-96` - Edge auth environment variables

### Deployment Guides
- `docs/deploy-to-kube.md` - K3S deployment guide (validated 2026-03-24)
- `brama-core/deploy/charts/brama/values-k3s-dev.yaml` - Local K3S example

## Notes

- **Webhook bypass for OpenClaw**: `/api/channels/` must bypass edge-auth (needed for Telegram webhooks) - see `docker/compose.openclaw.yaml:27-31`
- **Edge auth endpoints**: `/edge/auth/` must bypass edge-auth (needed for login to work) - see `docker/compose.core.yaml:20-23`
- **Cookie domain strategy**: Use host-only cookies (no domain) for each subdomain to avoid browser issues with `.localhost` domains
- **Priority routing**: Edge auth routes should have higher priority to be processed first

## Success Criteria

1. All external admin services accessible via proper domains
2. Edge authentication protects all services
3. Login flow works correctly with cookie propagation
4. Documentation exists for future deployments
5. No security vulnerabilities (webhooks work, login works, but unauthorized access blocked)
- **Started**: 2026-03-25 17:42:58
- **Branch**: pipeline/configure-production-domains-for-external-services
- **Pipeline ID**: 20260325_174256

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

