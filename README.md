# Brama Workspace

[🇺🇦 Ukrainian version](README.ua.md)

`brama-workspace` is the local development workspace for the Brama platform. It owns the developer runtime layer: devcontainer setup, Docker Compose topology, local environment templates, bootstrap scripts, and operator-focused helper commands.

Application source code stays in [`core`](/Users/nmdimas/work/brama-workspace/core), which remains a separate Git repository. The workspace repository is responsible for how the whole platform is assembled and run on a developer machine.

## Repository Layout

- [`.devcontainer/`](/Users/nmdimas/work/brama-workspace/.devcontainer) contains the workspace devcontainer image, hooks, and bootstrap helpers.
- [`docker/`](/Users/nmdimas/work/brama-workspace/docker) contains all Docker Compose files (`compose.yaml`, `compose.*.yaml`), Dockerfiles, and shared Docker assets.
- [`scripts/`](/Users/nmdimas/work/brama-workspace/scripts) contains bootstrap and operator helper scripts.
- [`Makefile`](/Users/nmdimas/work/brama-workspace/Makefile) is the main entry point for day-to-day commands.
- [`core/`](/Users/nmdimas/work/brama-workspace/core) contains the product codebase, tests, docs, and application-level assets.

## Requirements

For host-based workflow:

- Docker Desktop or Docker Engine with Compose v2
- Git
- GNU Make

For devcontainer workflow:

- VS Code with the Dev Containers extension
- Docker Desktop or Docker Engine with Compose v2

Optional but useful:

- `curl`
- `jq`
- `gh`

## Getting Started

The recommended open-source first step is to run `core` with only the storage-level dependencies it needs:

- PostgreSQL
- Redis

After that baseline works, move to the full Docker Compose stack or the Helm chart install.

### 1. Local Development via `.devcontainer`

Recommended when you want the most reproducible toolchain and you primarily develop `core` from source.

```bash
git clone <workspace-repo>
cd brama-workspace

cp .env.local.example .env.local
make bootstrap

# open the folder in VS Code and choose "Reopen in Container"
```

Inside the devcontainer, start with `core + postgres + redis`:

```bash
cd core/src
composer install
php bin/console doctrine:migrations:migrate --no-interaction
php bin/console server:start
```

Notes:

- The devcontainer shares the same Docker network as `postgres` and `redis`.
- `DATABASE_URL` and `REDIS_URL` already point to Docker hostnames.
- This path is best when you want to edit PHP code live and run only the minimal storage-backed app first.

When you want the larger workspace stack later:

```bash
make setup
make sync-skills
```

### 2. Docker Compose Setup

Use this when you want to run the platform from containers on the host without entering the devcontainer.

Minimal `core + postgres + redis` setup:

```bash
git clone <workspace-repo>
cd brama-workspace

cp .env.local.example .env.local
make bootstrap

docker compose --project-directory . \
  -f docker/compose.yaml \
  -f docker/compose.core.yaml \
  up -d postgres redis core

docker compose --project-directory . \
  -f docker/compose.yaml \
  -f docker/compose.core.yaml \
  exec core php bin/console doctrine:migrations:migrate --no-interaction
```

Access:

- `http://localhost`
- fallback direct port: `http://localhost:8081`

When you want the full supported local bundle instead of the minimal storage-backed setup:

```bash
make setup
make sync-skills
make up
make litellm-db-init
make migrate
```

### 3. Kubernetes via Helm Chart Values

Use this when you want the platform inside Kubernetes and prefer chart-driven configuration.

Chart location:

- [Brama Helm chart](/Users/nmdimas/work/brama-workspace/core/deploy/charts/brama)

Useful values files:

- local K3s/dev profile: [values-k3s-dev.yaml](/Users/nmdimas/work/brama-workspace/core/deploy/charts/brama/values-k3s-dev.yaml)
- production-oriented example: [values-prod.example.yaml](/Users/nmdimas/work/brama-workspace/core/deploy/charts/brama/values-prod.example.yaml)

For local K3s with the workspace helpers:

```bash
make k8s-build
make k8s-load
make k8s-secrets
make k8s-deploy
make k8s-status
```

This profile currently deploys:

- `core`
- `core-scheduler`
- `hello-agent`
- PostgreSQL
- Redis
- RabbitMQ

For a direct Helm install:

```bash
helm upgrade --install brama core/deploy/charts/brama \
  --namespace brama \
  --create-namespace \
  -f core/deploy/charts/brama/values-k3s-dev.yaml \
  --wait --timeout 5m
```

If you deploy to a non-local cluster, start from `values-prod.example.yaml` and provide your own images, secrets, ingress hostnames, and persistence settings.

## Daily Workflow

### Start or stop the stack

```bash
make up
make down
make ps
```

### Install dependencies

```bash
make install
make knowledge-install
make hello-install
make dev-agent-install
make dev-reporter-install
make news-install
make wiki-install
```

### Run tests and checks

```bash
make test
make knowledge-test
make hello-test
make dev-agent-test
make dev-reporter-test
make news-test
make wiki-test

make analyse
make knowledge-analyse
make hello-analyse
make dev-agent-analyse
make dev-reporter-analyse
make cs-check
make knowledge-cs-check
```

### Logs and debugging

```bash
make logs
make logs-core
make logs-traefik
make logs-litellm
make logs-openclaw
make logs-langfuse
```

### E2E and smoke validation

```bash
make verify-local-up
make verify-local-smoke
make e2e-smoke
make e2e
```

## Environment Files

- [`.env.local.example`](/Users/nmdimas/work/brama-workspace/.env.local.example) is the main local template. Copy it to `.env.local`.
- [`.env.deployment.example`](/Users/nmdimas/work/brama-workspace/.env.deployment.example) documents deployment-oriented overrides.
- `docker/openclaw/.env` is generated by `make bootstrap` and should stay local.

Best practice:

- Keep secrets only in local `.env` files.
- Treat `.env.local` as developer-specific state.
- Re-run `make bootstrap` after changing provider credentials or OpenClaw-related secrets.

## Core Commands

The workspace intentionally exposes a small set of high-value entry points:

- `make bootstrap`: generate and distribute local runtime secrets.
- `make setup`: prepare dependencies and build prerequisites for the current stack.
- `make up`: start the local platform.
- `make down`: stop the local platform.
- `make migrate`: run core database migrations.
- `make test`: run core automated tests.
- `make e2e`: run the full end-to-end suite.
- `make help`: print the complete command catalog.

## Compose Model

All Compose files live in the `docker/` directory:

- [`docker/compose.yaml`](/Users/nmdimas/work/brama-workspace/docker/compose.yaml): shared infrastructure such as Traefik, Postgres, Redis, OpenSearch, RabbitMQ, and LiteLLM.
- [`docker/compose.core.yaml`](/Users/nmdimas/work/brama-workspace/docker/compose.core.yaml): core application services.
- `docker/compose.agent-*.yaml`: platform agents and their local development services.
- [`docker/compose.openclaw.yaml`](/Users/nmdimas/work/brama-workspace/docker/compose.openclaw.yaml): OpenClaw gateway and CLI services.
- [`docker/compose.langfuse.yaml`](/Users/nmdimas/work/brama-workspace/docker/compose.langfuse.yaml): observability services.
- `docker/compose.fragments/`: external agent compose fragments.

The [`Makefile`](/Users/nmdimas/work/brama-workspace/Makefile) assembles the full stack for normal usage, so prefer `make` targets over manually typing long `docker compose -f ...` commands.

## Devcontainer Notes

The devcontainer is designed for workspace-level development:

- it mounts the whole workspace at `/workspaces/brama`
- it shares the same Compose topology as the host workflow
- it forwards `.env.local` into the container runtime
- it includes PHP, Node, Bun, Playwright, Docker CLI, Composer, Go, Claude Code, and OpenCode

If you update devcontainer image assets, rebuild the container instead of trying to patch an already running environment.

## Working With `core`

`core` is the application repository. Typical examples:

```bash
cd core
git status
```

The workspace repo and `core` repo are intentionally independent. Commit infra/runtime changes in the workspace repo, and commit application changes in `core`.

## Best Practices

- Prefer `make` targets over raw `docker compose` commands for routine tasks.
- Keep workspace-level changes in this repository and application-level changes in `core`.
- Use the devcontainer when you need a reproducible toolchain or Playwright-ready environment.
- Run `make verify-local-smoke` before larger E2E runs if you only need a quick runtime check.
- Avoid committing generated local state such as `.env.local`, `.local/`, or `docker/openclaw/.env`.
- When debugging service wiring, start with `make ps`, then targeted `make logs-*`.

## Troubleshooting

### Compose path or build issues

Run:

```bash
docker compose --project-directory . -f docker/compose.yaml -f docker/compose.core.yaml config
```

If this fails, the issue is usually a broken relative path in a compose file or Dockerfile.

### OpenClaw or provider setup is broken

Run:

```bash
make bootstrap
make logs-openclaw
```

### LiteLLM UI shows database-related errors

Run:

```bash
make litellm-db-init
```

### You changed dependencies inside the devcontainer

Run:

```bash
make setup
```

or rebuild the devcontainer if the issue is image-level rather than project-level.

## Related Repositories

- [`core`](/Users/nmdimas/work/brama-workspace/core): application source, tests, and product documentation.
