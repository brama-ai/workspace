# Pipeline Handoff

- **Task**: <!-- priority: 1 -->
# Implement Kubernetes-native agent discovery in AgentDiscoveryService

Implement the proposal from `brama-core/openspec/changes/add-kubernetes-agent-discovery/proposal.md`.

## Summary

The current `AgentDiscoveryService` only works in Docker Compose (queries Traefik API for `*-agent@docker` services). We need it to also work in Kubernetes by querying the K8s API for Services with label `ai.platform.agent=true`.

## Implementation Steps

### 1. Create provider interface
- `src/A2AGateway/Discovery/AgentDiscoveryProviderInterface.php`
- Method: `discover(): array` returning `list<array{hostname: string, port: int}>`

### 2. Extract TraefikDiscoveryProvider
- `src/A2AGateway/Discovery/TraefikDiscoveryProvider.php`
- Move existing Traefik API logic from `AgentDiscoveryService` into this class
- No behavior change — pure refactor

### 3. Implement KubernetesDiscoveryProvider
- `src/A2AGateway/Discovery/KubernetesDiscoveryProvider.php`
- Query: `GET /api/v1/namespaces/{ns}/services?labelSelector=ai.platform.agent=true`
- Use in-cluster SA token from `/var/run/secrets/kubernetes.io/serviceaccount/token`
- Namespace from `/var/run/secrets/kubernetes.io/serviceaccount/namespace`
- Extract hostname as `<service-name>.<namespace>.svc.cluster.local` and port from `spec.ports[]`

### 4. Refactor AgentDiscoveryService
- Add `AGENT_DISCOVERY_PROVIDER` env var (values: `auto`, `traefik`, `kubernetes`)
- `auto` (default): detect by checking for SA token file
- Delegate `discoverAgents()` to the resolved provider

### 5. Wire in services.yaml
- Register both providers
- Use env-based factory/alias for `AgentDiscoveryProviderInterface`

### 6. Update Helm chart
- `templates/agents/service.yaml`: add labels `ai.platform.agent: "true"` and `ai.platform.agent-name`
- `templates/agents/deployment.yaml`: add pod label `ai.platform.agent: "true"`
- NEW `templates/core/rbac.yaml`: Role + RoleBinding for `list services`
- `values.yaml`: add `core.env.AGENT_DISCOVERY_PROVIDER: auto`

## Validation

- PHPStan passes (level max)
- Existing unit tests pass
- New unit tests for KubernetesDiscoveryProvider (mock HTTP responses)
- `helm template` renders correctly with new labels and RBAC
- Docker Compose discovery still works (TraefikDiscoveryProvider unchanged)
- **Started**: 2026-03-24 14:11:55
- **Branch**: pipeline/implement-kubernetes-native-agent-discovery-in-age
- **Pipeline ID**: 20260324_141152

---

## Architect

- **Status**: pending
- **Change ID**: —
- **Apps affected**: —
- **DB changes**: —
- **API changes**: —

## Coder

- **Status**: completed
- **Files modified**:
  - `brama-core/src/src/A2AGateway/AgentDiscoveryService.php`
  - `brama-core/src/config/services.yaml`
  - `brama-core/deploy/charts/brama/templates/agents/service.yaml`
  - `brama-core/deploy/charts/brama/templates/agents/deployment.yaml`
  - `brama-core/deploy/charts/brama/values.yaml`
  - `brama-core/src/src/A2AGateway/Discovery/AgentDiscoveryProviderInterface.php` (new)
  - `brama-core/src/src/A2AGateway/Discovery/TraefikDiscoveryProvider.php` (new)
  - `brama-core/src/src/A2AGateway/Discovery/KubernetesDiscoveryProvider.php` (new)
  - `brama-core/src/src/A2AGateway/Discovery/AgentDiscoveryProviderFactory.php` (new)
  - `brama-core/src/tests/Unit/A2AGateway/Discovery/KubernetesDiscoveryProviderTest.php` (new)
  - `brama-core/deploy/charts/brama/templates/core/rbac.yaml` (new)
- **Migrations created**: none
- **Deviations**:
  - `brama-core/openspec/changes/add-kubernetes-agent-discovery/tasks.md` and `design.md` were not present in repository; implementation followed the proposal and task instructions from handoff.

## Validator

- **Status**: completed
- **PHPStan**:
  - `brama-core`: pass
- **CS-check**:
  - `brama-core`: pass
- **Files fixed**: none

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
- **Commit (coder)**: c8f9d51
