# Brama — Documentation Index

Agent-facing index of all project documentation. Load this file first to understand the documentation landscape.

---

## Platform & Core (`brama-core/docs/`)

### Deployed Agents

| Agent | Stack | Source | Status | PRD |
|-------|-------|--------|--------|-----|
| [hello-agent](agents/hello-agent/) | PHP 8.5 / Symfony 7 | in-repo + [external pilot](projects/hello-agent/) | Active | [EN](brama-core/docs/agents/en/hello-agent.md) · [UA](brama-core/docs/agents/ua/hello-agent.md) |
| [knowledge-agent](agents/knowledge-agent/) | PHP 8.5 / Symfony 7 | in-repo | Active | — |
| [news-maker-agent](agents/news-maker-agent/) | Python / FastAPI | in-repo | Active | — |
| [dev-reporter-agent](agents/dev-reporter-agent/) | PHP 8.5 / Symfony 7 | in-repo | Active | [EN](brama-core/docs/agents/en/dev-reporter-agent.md) · [UA](brama-core/docs/agents/ua/dev-reporter-agent.md) |
| [wiki-agent](agents/wiki-agent/) | TypeScript / Node.js | in-repo | Active | [EN](brama-core/docs/agents/en/wiki-agent.md) · [UA](brama-core/docs/agents/ua/wiki-agent.md) |

### Planned Agents (PRD only)

| Agent | PRD |
|-------|-----|
| anti-fraud-signals | [EN](brama-core/docs/agents/en/anti-fraud-signals-prd.md) · [UA](brama-core/docs/agents/ua/anti-fraud-signals-prd.md) |
| knowledge-extractor | [EN](brama-core/docs/agents/en/knowledge-extractor-prd.md) · [UA](brama-core/docs/agents/ua/knowledge-extractor-prd.md) |
| locations-catalog | [EN](brama-core/docs/agents/en/locations-catalog-prd.md) · [UA](brama-core/docs/agents/ua/locations-catalog-prd.md) |
| news-digest | [EN](brama-core/docs/agents/en/news-digest-prd.md) · [UA](brama-core/docs/agents/ua/news-digest-prd.md) |

### Platform Core

| Component | Path | Description |
|-----------|------|-------------|
| [core](brama-core/src/) | `brama-core/src/` | Admin UI, A2A gateway, agent registry, log viewer |

### Platform Links

- [Agent conventions](brama-core/docs/agent-requirements/conventions.md)
- [Multi-agent pipeline](brama-core/docs/features/pipeline/en/pipeline.md)
- [Dashboard platform metrics](brama-core/docs/features/dashboard-metrics/en/dashboard-metrics.md)
- [i18n Locale Cookie](brama-core/docs/features/i18n-locale/en/i18n-locale.md)
- [Agent Card schema](brama-core/src/config/agent-card.schema.json)
- [Local dev guide](brama-core/docs/setup/local-dev/en/local-dev.md)
- [Production deployment guide](brama-core/docs/guides/deployment/en/deployment.md)
- [Deployment overview](brama-core/docs/guides/deployment/en/deployment-overview.md)
- [A2A terminology mapping (EN)](brama-core/docs/specs/en/a2a-terminology-mapping.md)
- [External agent workspace](brama-core/docs/guides/external-agents/en/external-agent-workspace.md)
- [External agent operator onboarding](brama-core/docs/guides/external-agents/en/operator-onboarding.md)
- [External agent migration playbook](brama-core/docs/guides/external-agents/en/migration-playbook.md)
- [Pilot agent selection](brama-core/docs/guides/external-agents/en/pilot-agent-selection.md)
- [Oh My OpenCode (OmO) integration](brama-core/docs/guides/oh-my-opencode/en/oh-my-opencode.md)
- [Oh My OpenCode — Quick Start](brama-core/docs/guides/oh-my-opencode/en/quickstart.md)

### Deployment & Operations

- [Deploying to Kubernetes (K3s)](docs/deploy-to-kube.md) — Build, deploy, domain config (Cloudflare Tunnel), rollback
- [Deployer agent](docs/pipeline/en/deployer-agent.md) — Pipeline Phase 8: automated deployment

---

## Workspace Setup (`docs/workspace-setup/`)

- [docs/workspace-setup/en/setup.md](docs/workspace-setup/en/setup.md) — Full workspace setup: clone, devcontainer, providers, Foundry monitor
- [docs/workspace-setup/ua/setup.md](docs/workspace-setup/ua/setup.md) — Повне налаштування workspace (UA)

---

## Developer Workflow (`docs/`)

### Agent Development

- [docs/agent-development/en/workflow.md](docs/agent-development/en/workflow.md) — Pipeline workflow diagrams: agent orchestration, profile selection, communication
- [docs/agent-development/en/foundry.md](docs/agent-development/en/foundry.md) — Foundry: file-based pipeline, task creation, monitoring, batch execution
- [docs/agent-development/en/ultraworks.md](docs/agent-development/en/ultraworks.md) — Ultraworks (Sisyphus): OpenCode-native orchestration, tmux multi-task, headless mode
- [docs/agent-development/en/openspec.md](docs/agent-development/en/openspec.md) — OpenSpec per-project convention: why specs live in projects, not workspace root

---

Brama Agent Platform is the public product name for this repository. Legacy runtime identifiers may
still use `ai-community-platform` until the infrastructure rename is handled separately.
