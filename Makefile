CORE_ROOT := brama-core
CORE_SRC  := $(CORE_ROOT)/src
AGENTS_DIR := brama-agents
TEST_ROOT := $(CORE_ROOT)/tests

DOCKER_DIR := docker
DEVCONTAINER_DIR := .devcontainer
DEVCONTAINER_COMPOSE_FILES := -f $(DOCKER_DIR)/compose.yaml -f $(DOCKER_DIR)/compose.core.yaml -f $(DEVCONTAINER_DIR)/docker-compose.yml
DEVCONTAINER_COMPOSE ?= docker compose $(DEVCONTAINER_COMPOSE_FILES)
DEVCONTAINER_SERVICE ?= devcontainer

# docker-outside-of-docker: resolve host project path for bind mounts.
# Inside devcontainer /workspaces/brama ≠ host path, so we auto-detect it.
ifndef HOST_PROJECT_DIR
  _DEVCONTAINER_SRC := $(shell docker inspect brama-devcontainer-1 --format '{{range .Mounts}}{{if eq .Destination "/workspaces/brama"}}{{.Source}}{{end}}{{end}}' 2>/dev/null)
  ifneq ($(_DEVCONTAINER_SRC),)
    export HOST_PROJECT_DIR := $(_DEVCONTAINER_SRC)
  endif
endif

# ── Kubernetes / Helm ──────────────────────────────────────────────────────
HELM_CHART   := $(CORE_ROOT)/deploy/charts/brama
HELM_RELEASE ?= brama
K8S_NAMESPACE ?= brama
K8S_VALUES   ?= $(HELM_CHART)/values-k3s-dev.yaml
K8S_CORE_IMAGE ?= brama/core:dev
K8S_HELLO_IMAGE ?= brama/hello-agent:dev
AGENT_FILES := $(sort $(wildcard $(DOCKER_DIR)/compose.agent-*.yaml))
EXTERNAL_AGENT_FILES := $(sort $(wildcard $(DOCKER_DIR)/compose.fragments/*.yaml))
OVERRIDE_FILE := $(firstword $(wildcard $(DOCKER_DIR)/compose.override.yaml $(DOCKER_DIR)/compose.override.yml))
OVERRIDE_COMPOSE := $(if $(OVERRIDE_FILE),-f $(OVERRIDE_FILE),)
COMPOSE_FILES := -f $(DOCKER_DIR)/compose.yaml -f $(DOCKER_DIR)/compose.core.yaml \
        $(addprefix -f ,$(AGENT_FILES)) \
        $(addprefix -f ,$(EXTERNAL_AGENT_FILES)) \
        -f $(DOCKER_DIR)/compose.langfuse.yaml -f $(DOCKER_DIR)/compose.openclaw.yaml \
        $(OVERRIDE_COMPOSE)
COMPOSE ?= docker compose $(COMPOSE_FILES)
VERIFY_LOCAL_COMPOSE ?= docker compose -f $(DOCKER_DIR)/compose.yaml -f $(DOCKER_DIR)/compose.core.yaml -f $(DOCKER_DIR)/compose.website.yaml
E2E_COMPOSE ?= docker compose $(COMPOSE_FILES) --profile e2e
E2E_CORE_DB ?= brama_test
E2E_BASE_URL ?= http://localhost:18080
# Devcontainer detection: run commands locally when inside a devcontainer
IS_DEVCONTAINER := $(or $(REMOTE_CONTAINERS),$(CODESPACES),$(RUNNING_IN_DEVCONTAINER))
# Load devcontainer-specific E2E URLs when running inside devcontainer
E2E_ENV_FILE := $(if $(IS_DEVCONTAINER),$(wildcard .env.e2e.devcontainer),)
E2E_ENV_EXPORT := $(if $(E2E_ENV_FILE),set -a && . $(CURDIR)/$(E2E_ENV_FILE) && set +a &&,)
# run-in <service> <local-path> <command...>  — run locally (cd <local-path>) or via docker compose exec
define run-in
$(if $(IS_DEVCONTAINER),cd $(2) && $(3),$(COMPOSE) exec $(1) $(3))
endef

.PHONY: help bootstrap setup infra-setup core-setup knowledge-setup news-setup hello-setup dev-reporter-setup wiki-setup dev-agent-setup claw-setup \
	openclaw-frontdesk-sync \
	devcontainer-up devcontainer-shell e2e-in-devcontainer e2e-smoke-in-devcontainer e2e-inner e2e-smoke-inner \
        up up-observability down ps logs logs-traefik logs-core logs-litellm logs-openclaw logs-langfuse \
        agent-up agent-down \
        litellm-db-init e2e-db-init e2e-rabbitmq-init e2e-register-agents e2e-prepare e2e-env-check e2e-cleanup \
        install migrate test analyse cs-check cs-fix e2e e2e-smoke verify-local-up verify-local-smoke verify-local \
        knowledge-install knowledge-migrate knowledge-test knowledge-analyse knowledge-cs-check knowledge-cs-fix \
        wiki-install wiki-test wiki-build \
        hello-install hello-test hello-analyse hello-cs-check hello-cs-fix \
        news-install news-migrate news-test news-analyse news-cs-check news-cs-fix \
        dev-reporter-install dev-reporter-migrate dev-reporter-test dev-reporter-analyse dev-reporter-cs-check dev-reporter-cs-fix \
        dev-agent-install dev-agent-migrate dev-agent-test dev-agent-analyse dev-agent-cs-check dev-agent-cs-fix \
        agent-discover conventions-test \
        external-agent-list external-agent-up external-agent-down external-agent-clone \
        sync-skills foundry foundry-headless pipeline pipeline-batch monitor-foundry monitor-builder monitor-ultraworks \
        monitor-ultraworks-launch monitor-ultraworks-attach monitor-ultraworks-watch monitor-ultraworks-menu \
        k8s-ctx k8s-ns k8s-deps k8s-deploy k8s-upgrade k8s-status k8s-logs k8s-destroy k8s-diff k8s-shell \
        k8s-build k8s-load k8s-secrets k8s-setup

help:
	@printf '%s\n' \
		'make bootstrap             Configure secrets from .env.local (run once before setup)' \
		'make setup                Pull/build the current local stack dependencies (core + agents + claw + infra)' \
		'make devcontainer-up      Start the shared devcontainer service used for host-driven E2E runs' \
		'make devcontainer-shell   Open a shell in the shared devcontainer service' \
		'make openclaw-frontdesk-sync  Sync frontdesk policy files into .local/openclaw/state/workspace' \
		'make install              Install PHP dependencies via Composer inside the core container' \
		'make knowledge-install    Install PHP dependencies inside the knowledge-agent container' \
		'make news-install         Install Python dependencies inside the news-maker-agent container' \
		'make up                   Start the local stack in the background' \
		'make wiki-install         Install Node dependencies inside the wiki-agent container' \
		'make wiki-build           Run TypeScript build checks for wiki-agent (stack must be up)' \
		'make wiki-test            Run wiki-agent tests (stack must be up)' \
		'make agent-up name=X      Start/update a single agent (e.g. make agent-up name=hello-agent)' \
		'make agent-down name=X    Stop a single agent (e.g. make agent-down name=hello-agent)' \
		'make down                 Stop the local stack' \
		'make ps                   Show running services' \
		'make logs                 Follow logs for all services' \
		'make logs-traefik         Follow Traefik logs' \
		'make logs-core            Follow core logs' \
		'make logs-litellm         Follow LiteLLM logs' \
		'make logs-openclaw        Follow OpenClaw gateway logs' \
		'make logs-langfuse        Follow Langfuse web/worker logs' \
		'make litellm-db-init      Ensure LiteLLM Postgres DB exists (fixes UI auth DB errors)' \
		'make e2e-prepare          Prepare full E2E stack (DBs + RabbitMQ vhost + migrations + agent registration)' \
		'make e2e-env-check        Verify E2E endpoints are healthy before running Codecept/Playwright' \
		'make e2e-register-agents  Register and enable agents in core-e2e (called by e2e-prepare)' \
		'make e2e-cleanup          Stop all E2E containers' \
		'make e2e-in-devcontainer  Run the full E2E suite inside the shared devcontainer' \
		'make e2e-smoke-in-devcontainer  Run smoke E2E inside the shared devcontainer' \
		'make test                 Run Codeception unit + functional suites for core (stack must be up)' \
		'make knowledge-test       Run Codeception suites for knowledge-agent (stack must be up)' \
		'make hello-install         Install PHP dependencies inside the hello-agent container' \
		'make hello-test            Run Codeception suites for hello-agent (stack must be up)' \
		'make hello-analyse         Run PHPStan static analysis for hello-agent (stack must be up)' \
		'make hello-cs-check        Check code style for hello-agent with PHP CS Fixer (stack must be up)' \
		'make hello-cs-fix          Fix code style for hello-agent with PHP CS Fixer (stack must be up)' \
		'make dev-reporter-install  Install PHP dependencies inside the dev-reporter-agent container' \
		'make dev-reporter-test     Run Codeception suites for dev-reporter-agent (stack must be up)' \
		'make dev-reporter-analyse  Run PHPStan static analysis for dev-reporter-agent (stack must be up)' \
		'make dev-reporter-cs-check Check code style for dev-reporter-agent with PHP CS Fixer (stack must be up)' \
		'make dev-reporter-cs-fix   Fix code style for dev-reporter-agent with PHP CS Fixer (stack must be up)' \
		'make dev-reporter-migrate  Run Doctrine migrations for dev-reporter-agent (stack must be up)' \
		'make news-test            Run pytest suites for news-maker-agent (stack must be up)' \
		'make news-analyse         Run ruff check for news-maker-agent (stack must be up)' \
		'make news-cs-check        Run ruff format check for news-maker-agent (stack must be up)' \
		'make news-cs-fix          Run ruff format fix for news-maker-agent (stack must be up)' \
		'make analyse              Run PHPStan static analysis for core (stack must be up)' \
		'make knowledge-analyse    Run PHPStan static analysis for knowledge-agent (stack must be up)' \
		'make cs-check             Check code style for core with PHP CS Fixer (stack must be up)' \
		'make knowledge-cs-check   Check code style for knowledge-agent with PHP CS Fixer (stack must be up)' \
		'make cs-fix               Fix code style for core with PHP CS Fixer (stack must be up)' \
		'make knowledge-cs-fix     Fix code style for knowledge-agent with PHP CS Fixer (stack must be up)' \
		'make migrate              Run Doctrine migrations for core (stack must be up)' \
		'make knowledge-migrate    Run Doctrine migrations for knowledge-agent (stack must be up)' \
		'make news-migrate         Run Alembic migrations for news-maker-agent (stack must be up)' \
		'make agent-discover       Run Traefik-based agent discovery and refresh registry' \
		'make conventions-test     Run Codecept.js agent-convention compliance tests (AGENT_URL required)' \
		'make external-agent-list  List detected external agent compose fragments in docker/compose.fragments/' \
		'make external-agent-up name=X    Start/update a named external agent (e.g. make external-agent-up name=my-agent)' \
		'make external-agent-down name=X  Stop a named external agent (e.g. make external-agent-down name=my-agent)' \
		'make external-agent-clone repo=URL name=X  Clone an agent repo into brama-agents/<name> (e.g. make external-agent-clone repo=https://github.com/org/my-agent name=my-agent)' \
		'make verify-local-up      Start the minimal local stack for admin login, LiteLLM, and landing verification' \
		'make verify-local-smoke   Verify admin login, LiteLLM, and landing endpoints via curl-based smoke checks' \
		'make verify-local         Run local smoke verification and then the full E2E suite' \
		'make e2e                  Run Codecept.js + Playwright E2E tests (full isolated stack)' \
		'make e2e-smoke            Run smoke-only E2E tests (API checks, no browser)' \
		'make monitor-foundry      Monitor Foundry runtime' \
		'make monitor-builder      Legacy alias for Foundry monitor' \
		'make monitor-ultraworks   Monitor ultraworks pipeline (OpenCode/Sisyphus)' \
		'make monitor-ultraworks-launch TASK="desc"  Launch OpenCode in tmux' \
		'make monitor-ultraworks-attach  Attach to tmux session' \
		'make monitor-ultraworks-menu    Interactive menu' \
		'' \
		'── Kubernetes / K3S ──────────────────────────────────────────' \
		'make k8s-setup             Full setup: build + load + secrets + deploy' \
		'make k8s-ctx               Show current kubectl context and cluster info' \
		'make k8s-build             Build Docker images for K3S deployment' \
		'make k8s-load              Import local Docker images into K3S containerd' \
		'make k8s-secrets           Create K8S secrets for the platform' \
		'make k8s-deploy            Deploy (or upgrade) the Helm chart to K3S' \
		'make k8s-upgrade           Upgrade existing Helm release' \
		'make k8s-diff              Show diff of pending Helm changes (requires helm-diff plugin)' \
		'make k8s-status            Show pods, services, ingress, and release status' \
		'make k8s-logs svc=X        Follow logs for a component (core, core-scheduler, agent-hello)' \
		'make k8s-logs-all          Follow logs for all platform services' \
		'make k8s-shell svc=X       Open a shell in a running pod (core, core-scheduler, agent-hello)' \
		'make k8s-port-forward svc=X port=LOCAL:REMOTE  Port-forward a service (core, agent-hello)' \
		'make k8s-destroy           Uninstall the Helm release'

bootstrap:
	@./scripts/bootstrap.sh

openclaw-frontdesk-sync:
	@./scripts/sync-openclaw-frontdesk.sh

setup: infra-setup core-setup knowledge-setup hello-setup news-setup dev-reporter-setup wiki-setup dev-agent-setup claw-setup
	@echo "Local development dependencies are prepared."

infra-setup:
	$(if $(IS_DEVCONTAINER),@echo "Devcontainer: PostgreSQL and Redis already running locally",$(COMPOSE) pull traefik postgres redis opensearch rabbitmq litellm)

core-setup:
	$(if $(IS_DEVCONTAINER),cd $(CORE_SRC) && composer install && ./vendor/bin/codecept build,$(COMPOSE) build core && $(COMPOSE) run --rm core composer install && $(COMPOSE) run --rm core ./vendor/bin/codecept build)

knowledge-setup:
	$(if $(IS_DEVCONTAINER),cd $(AGENTS_DIR)/knowledge-agent && composer install && ./vendor/bin/codecept build,$(COMPOSE) build knowledge-agent && $(COMPOSE) run --rm knowledge-agent composer install && $(COMPOSE) run --rm knowledge-agent ./vendor/bin/codecept build)

hello-setup:
	$(if $(IS_DEVCONTAINER),cd $(AGENTS_DIR)/hello-agent && composer install && ./vendor/bin/codecept build,$(COMPOSE) build hello-agent && $(COMPOSE) run --rm hello-agent composer install && $(COMPOSE) run --rm hello-agent ./vendor/bin/codecept build)

dev-reporter-setup:
	$(if $(IS_DEVCONTAINER),cd $(AGENTS_DIR)/dev-reporter-agent && composer install && ./vendor/bin/codecept build,$(COMPOSE) build dev-reporter-agent && $(COMPOSE) run --rm dev-reporter-agent composer install && $(COMPOSE) run --rm dev-reporter-agent ./vendor/bin/codecept build)

dev-agent-setup:
	$(if $(IS_DEVCONTAINER),cd $(AGENTS_DIR)/dev-agent && composer install && ./vendor/bin/codecept build,$(COMPOSE) build dev-agent && $(COMPOSE) run --rm dev-agent composer install && $(COMPOSE) run --rm dev-agent ./vendor/bin/codecept build)

wiki-setup:
	$(if $(IS_DEVCONTAINER),cd $(AGENTS_DIR)/wiki-agent && npm install,$(COMPOSE) build wiki-agent && $(COMPOSE) run --rm wiki-agent npm install)

news-setup:
	$(if $(IS_DEVCONTAINER),cd $(AGENTS_DIR)/news-maker-agent && pip install -r requirements.txt,$(COMPOSE) build news-maker-agent && $(COMPOSE) run --rm news-maker-agent pip install -r requirements.txt)

claw-setup:
	mkdir -p .local/openclaw/state .local/openclaw/e2e-state
	$(if $(IS_DEVCONTAINER),@echo "Devcontainer: skipping OpenClaw Docker pull",$(COMPOSE) pull openclaw-gateway openclaw-cli)

install:
	$(if $(IS_DEVCONTAINER),cd $(CORE_SRC) && composer install,$(COMPOSE) run --rm core composer install)

knowledge-install:
	$(if $(IS_DEVCONTAINER),cd $(AGENTS_DIR)/knowledge-agent && composer install,$(COMPOSE) run --rm knowledge-agent composer install)

hello-install:
	$(if $(IS_DEVCONTAINER),cd $(AGENTS_DIR)/hello-agent && composer install,$(COMPOSE) run --rm hello-agent composer install)

dev-reporter-install:
	$(if $(IS_DEVCONTAINER),cd $(AGENTS_DIR)/dev-reporter-agent && composer install,$(COMPOSE) run --rm dev-reporter-agent composer install)

dev-agent-install:
	$(if $(IS_DEVCONTAINER),cd $(AGENTS_DIR)/dev-agent && composer install,$(COMPOSE) run --rm dev-agent composer install)

news-install:
	$(if $(IS_DEVCONTAINER),cd $(AGENTS_DIR)/news-maker-agent && pip install -r requirements.txt,$(COMPOSE) run --rm news-maker-agent pip install -r requirements.txt)

wiki-install:
	$(if $(IS_DEVCONTAINER),cd $(AGENTS_DIR)/wiki-agent && npm install,$(COMPOSE) run --rm wiki-agent npm install)

up:
	$(if $(IS_DEVCONTAINER),@echo "Devcontainer: services (PostgreSQL, Redis) already running. Use 'php $(CORE_SRC)/bin/console server:start' to run Symfony.",$(COMPOSE) up --build -d)

agent-up:
	$(if $(IS_DEVCONTAINER),@echo "Devcontainer: start agents directly — e.g. cd $(AGENTS_DIR)/$(name) && php bin/console server:start",$(COMPOSE) up --build -d $(name))

agent-down:
	$(if $(IS_DEVCONTAINER),@echo "Devcontainer: stop agents directly",$(COMPOSE) stop $(name))

# ── External Agent Targets ───────────────────────────────────────────────────

external-agent-list:
	@./scripts/external-agent.sh list

external-agent-up:
	@test -n "$(name)" || (echo "Usage: make external-agent-up name=<agent-name>" && exit 1)
	@./scripts/external-agent.sh up "$(name)"

external-agent-down:
	@test -n "$(name)" || (echo "Usage: make external-agent-down name=<agent-name>" && exit 1)
	@./scripts/external-agent.sh down "$(name)"

external-agent-clone:
	@test -n "$(repo)" || (echo "Usage: make external-agent-clone repo=<git-url> name=<agent-name>" && exit 1)
	@test -n "$(name)" || (echo "Usage: make external-agent-clone repo=<git-url> name=<agent-name>" && exit 1)
	@./scripts/external-agent.sh clone "$(repo)" "$(name)"

up-observability:
	$(COMPOSE) up -d langfuse-web langfuse-worker

down:
	$(COMPOSE) down

ps:
	$(COMPOSE) ps

logs:
	$(COMPOSE) logs -f

logs-traefik:
	$(COMPOSE) logs -f traefik

logs-core:
	$(COMPOSE) logs -f core

logs-litellm:
	$(COMPOSE) logs -f litellm

logs-openclaw:
	$(COMPOSE) logs -f openclaw-gateway

logs-langfuse:
	$(COMPOSE) logs -f langfuse-web langfuse-worker

litellm-db-init:
	$(COMPOSE) up -d postgres
	@printf "SELECT 'CREATE DATABASE litellm' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'litellm')\\gexec\n" | $(COMPOSE) exec -T postgres psql -U app -d brama
	$(COMPOSE) up -d litellm

e2e-db-init:
	$(COMPOSE) up -d postgres
	@printf "SELECT 'CREATE DATABASE brama_test' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'brama_test')\\gexec\n" | $(COMPOSE) exec -T postgres psql -U app -d postgres
	@printf "SELECT 'CREATE DATABASE knowledge_agent_test OWNER knowledge_agent' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'knowledge_agent_test')\\gexec\n" | $(COMPOSE) exec -T postgres psql -U app -d postgres
	@printf "SELECT 'CREATE DATABASE news_maker_agent_test OWNER news_maker_agent' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'news_maker_agent_test')\\gexec\n" | $(COMPOSE) exec -T postgres psql -U app -d postgres
	@printf "SELECT 'CREATE DATABASE dev_reporter_agent_test OWNER dev_reporter_agent' WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'dev_reporter_agent_test')\\gexec\n" | $(COMPOSE) exec -T postgres psql -U app -d postgres

e2e-rabbitmq-init:
	$(COMPOSE) up -d rabbitmq
	@$(COMPOSE) exec -T rabbitmq rabbitmqctl add_vhost test 2>/dev/null || true
	@$(COMPOSE) exec -T rabbitmq rabbitmqctl set_permissions -p test app ".*" ".*" ".*"

e2e-register-agents:
	@echo "Registering E2E agents in core-e2e..."
	@$(E2E_ENV_EXPORT) curl -sf -X POST $${BASE_URL:-$(E2E_BASE_URL)}/api/v1/internal/agents/register \
		-H "Content-Type: application/json" \
		-H "X-Platform-Internal-Token: dev-internal-token" \
		-d '{"name":"hello-agent","version":"1.0.0","description":"Simple hello-world reference agent","url":"http://hello-agent-e2e/api/v1/a2a","health_url":"http://hello-agent-e2e/health","skills":[{"id":"hello.greet","name":"Hello Greet","description":"Greet a user by name"}],"skill_schemas":{"hello.greet":{"input_schema":{"type":"object","properties":{"name":{"type":"string"}}}}}}' \
		&& echo "  registered hello-agent" || echo "  FAILED hello-agent"
	@$(E2E_ENV_EXPORT) curl -sf -X POST $${BASE_URL:-$(E2E_BASE_URL)}/api/v1/internal/agents/register \
		-H "Content-Type: application/json" \
		-H "X-Platform-Internal-Token: dev-internal-token" \
		-d '{"name":"knowledge-agent","version":"1.0.0","description":"Knowledge base management and semantic search","url":"http://knowledge-agent-e2e/api/v1/knowledge/a2a","health_url":"http://knowledge-agent-e2e/health","admin_url":"http://localhost:18083/admin/knowledge","skills":[{"id":"knowledge.search","name":"Knowledge Search","description":"Search the knowledge base"},{"id":"knowledge.upload","name":"Knowledge Upload","description":"Extract and store knowledge from messages"},{"id":"knowledge.store_message","name":"Knowledge Store Message","description":"Persist source messages with metadata"}]}' \
		&& echo "  registered knowledge-agent" || echo "  FAILED knowledge-agent"
	@$(E2E_ENV_EXPORT) curl -sf -X POST $${BASE_URL:-$(E2E_BASE_URL)}/api/v1/internal/agents/register \
		-H "Content-Type: application/json" \
		-H "X-Platform-Internal-Token: dev-internal-token" \
		-d '{"name":"news-maker-agent","version":"0.1.0","description":"AI-powered news curation and publishing","url":"http://news-maker-agent-e2e:8000/api/v1/a2a","health_url":"http://news-maker-agent-e2e:8000/health","admin_url":"http://localhost:18084/admin/sources","skills":[{"id":"news.publish","name":"News Publish","description":"Publish curated news content"},{"id":"news.curate","name":"News Curate","description":"Curate and summarize news articles"}]}' \
		&& echo "  registered news-maker-agent" || echo "  FAILED news-maker-agent"
	@$(E2E_ENV_EXPORT) curl -sf -X POST $${BASE_URL:-$(E2E_BASE_URL)}/api/v1/internal/agents/register \
		-H "Content-Type: application/json" \
		-H "X-Platform-Internal-Token: dev-internal-token" \
		-d '{"name":"dev-reporter-agent","version":"1.0.0","description":"Pipeline observability agent","url":"http://dev-reporter-agent-e2e/api/v1/a2a","health_url":"http://dev-reporter-agent-e2e/health","admin_url":"http://localhost:18087/admin/pipeline","skills":[{"id":"devreporter.ingest","name":"Pipeline Ingest","description":"Ingest pipeline run reports"},{"id":"devreporter.status","name":"Pipeline Status","description":"Query pipeline run status"},{"id":"devreporter.notify","name":"Pipeline Notify","description":"Send notification messages"}]}' \
		&& echo "  registered dev-reporter-agent" || echo "  FAILED dev-reporter-agent"
	@$(E2E_COMPOSE) exec -T postgres psql -U app -d brama_test -q \
		-c "UPDATE agent_registry SET enabled = true, installed_at = now() WHERE name IN ('hello-agent', 'knowledge-agent', 'news-maker-agent', 'dev-reporter-agent') AND tenant_id = '00000000-0000-4000-a000-000000000001'"
	@$(E2E_COMPOSE) exec -T postgres psql -U app -d brama_test -q \
		-c "INSERT INTO scheduled_jobs (agent_name, job_name, skill_id, payload, cron_expression, next_run_at, max_retries, retry_delay_seconds, timezone, tenant_id) VALUES ('hello-agent', 'daily-greeting', 'hello.greet', '{\"name\": \"Дмитро\"}', '0 9 * * *', now() + interval '1 day', 2, 120, 'Europe/Kyiv', '00000000-0000-4000-a000-000000000001') ON CONFLICT (agent_name, job_name, tenant_id) DO NOTHING"
	@echo "E2E agents registered and enabled."

e2e-prepare: e2e-db-init e2e-rabbitmq-init
	$(E2E_COMPOSE) up -d --build traefik core-e2e core-scheduler-e2e knowledge-agent-e2e knowledge-worker-e2e news-maker-agent-e2e hello-agent-e2e dev-reporter-agent-e2e openclaw-gateway-e2e langfuse-postgres langfuse-clickhouse langfuse-redis langfuse-minio langfuse-minio-init langfuse-web langfuse-worker
	$(E2E_COMPOSE) exec -T core-e2e php bin/console doctrine:migrations:migrate --no-interaction
	$(E2E_COMPOSE) exec -T knowledge-agent-e2e php bin/console doctrine:migrations:migrate --no-interaction
	$(E2E_COMPOSE) exec -T dev-reporter-agent-e2e php bin/console doctrine:migrations:migrate --no-interaction
	$(E2E_COMPOSE) exec -T news-maker-agent-e2e alembic upgrade head
	@$(MAKE) e2e-register-agents
	$(E2E_COMPOSE) exec -T core-e2e php bin/console app:agent-health-poll

e2e-cleanup:
	$(E2E_COMPOSE) stop traefik core-e2e core-scheduler-e2e knowledge-agent-e2e knowledge-worker-e2e news-maker-agent-e2e hello-agent-e2e dev-reporter-agent-e2e openclaw-gateway-e2e langfuse-postgres langfuse-clickhouse langfuse-redis langfuse-minio langfuse-minio-init langfuse-web langfuse-worker 2>/dev/null || true

e2e-env-check:
	$(E2E_ENV_EXPORT) \
	BASE_URL=$${BASE_URL:-$(E2E_BASE_URL)} \
	CORE_DB_NAME=$${CORE_DB_NAME:-$(E2E_CORE_DB)} \
	KNOWLEDGE_URL=$${KNOWLEDGE_URL:-http://localhost:18083} \
	NEWS_URL=$${NEWS_URL:-http://localhost:18084} \
	HELLO_URL=$${HELLO_URL:-http://localhost:18085} \
	DEV_REPORTER_URL=$${DEV_REPORTER_URL:-http://localhost:18087} \
	OPENCLAW_URL=$${OPENCLAW_URL:-http://localhost:28789} \
	./scripts/e2e-env-check.sh

migrate:
	$(call run-in,core,$(CORE_SRC),php bin/console doctrine:migrations:migrate --no-interaction)

knowledge-migrate:
	$(call run-in,knowledge-agent,$(AGENTS_DIR)/knowledge-agent,php bin/console doctrine:migrations:migrate --no-interaction)

dev-reporter-migrate:
	$(call run-in,dev-reporter-agent,$(AGENTS_DIR)/dev-reporter-agent,php bin/console doctrine:migrations:migrate --no-interaction)

dev-agent-migrate:
	$(call run-in,dev-agent,$(AGENTS_DIR)/dev-agent,php bin/console doctrine:migrations:migrate --no-interaction)

news-migrate:
	$(call run-in,news-maker-agent,$(AGENTS_DIR)/news-maker-agent,alembic upgrade head)

wiki-build:
	$(call run-in,wiki-agent,$(AGENTS_DIR)/wiki-agent,npm run build)

wiki-test:
	$(call run-in,wiki-agent,$(AGENTS_DIR)/wiki-agent,npm run test)

test:
	$(call run-in,core,$(CORE_SRC),./vendor/bin/codecept run)

knowledge-test:
	$(call run-in,knowledge-agent,$(AGENTS_DIR)/knowledge-agent,./vendor/bin/codecept run)

hello-test:
	$(call run-in,hello-agent,$(AGENTS_DIR)/hello-agent,./vendor/bin/codecept run)

dev-reporter-test:
	$(call run-in,dev-reporter-agent,$(AGENTS_DIR)/dev-reporter-agent,./vendor/bin/codecept run)

dev-agent-test:
	$(call run-in,dev-agent,$(AGENTS_DIR)/dev-agent,./vendor/bin/codecept run)

news-test:
	$(call run-in,news-maker-agent,$(AGENTS_DIR)/news-maker-agent,python -m pytest tests/ -v)

news-analyse:
	$(call run-in,news-maker-agent,$(AGENTS_DIR)/news-maker-agent,ruff check app/ tests/)

news-cs-check:
	$(call run-in,news-maker-agent,$(AGENTS_DIR)/news-maker-agent,ruff format --check app/ tests/)

news-cs-fix:
	$(call run-in,news-maker-agent,$(AGENTS_DIR)/news-maker-agent,ruff format app/ tests/)

analyse:
	$(call run-in,core,$(CORE_SRC),./vendor/bin/phpstan analyse)

hello-analyse:
	$(call run-in,hello-agent,$(AGENTS_DIR)/hello-agent,./vendor/bin/phpstan analyse)

dev-reporter-analyse:
	$(call run-in,dev-reporter-agent,$(AGENTS_DIR)/dev-reporter-agent,./vendor/bin/phpstan analyse)

dev-agent-analyse:
	$(call run-in,dev-agent,$(AGENTS_DIR)/dev-agent,./vendor/bin/phpstan analyse)

knowledge-analyse:
	$(call run-in,knowledge-agent,$(AGENTS_DIR)/knowledge-agent,./vendor/bin/phpstan analyse)

cs-check:
	$(call run-in,core,$(CORE_SRC),./vendor/bin/php-cs-fixer check --diff --allow-risky=yes)

hello-cs-check:
	$(call run-in,hello-agent,$(AGENTS_DIR)/hello-agent,./vendor/bin/php-cs-fixer check --diff --allow-risky=yes)

dev-reporter-cs-check:
	$(call run-in,dev-reporter-agent,$(AGENTS_DIR)/dev-reporter-agent,./vendor/bin/php-cs-fixer check --diff --allow-risky=yes)

dev-agent-cs-check:
	$(call run-in,dev-agent,$(AGENTS_DIR)/dev-agent,./vendor/bin/php-cs-fixer check --diff --allow-risky=yes)

knowledge-cs-check:
	$(call run-in,knowledge-agent,$(AGENTS_DIR)/knowledge-agent,./vendor/bin/php-cs-fixer check --diff --allow-risky=yes)

cs-fix:
	$(call run-in,core,$(CORE_SRC),./vendor/bin/php-cs-fixer fix --allow-risky=yes)

hello-cs-fix:
	$(call run-in,hello-agent,$(AGENTS_DIR)/hello-agent,./vendor/bin/php-cs-fixer fix --allow-risky=yes)

dev-reporter-cs-fix:
	$(call run-in,dev-reporter-agent,$(AGENTS_DIR)/dev-reporter-agent,./vendor/bin/php-cs-fixer fix --allow-risky=yes)

dev-agent-cs-fix:
	$(call run-in,dev-agent,$(AGENTS_DIR)/dev-agent,./vendor/bin/php-cs-fixer fix --allow-risky=yes)

knowledge-cs-fix:
	$(call run-in,knowledge-agent,$(AGENTS_DIR)/knowledge-agent,./vendor/bin/php-cs-fixer fix --allow-risky=yes)

agent-discover:
	$(call run-in,core,$(CORE_SRC),php bin/console agent:discovery)

logs-setup:
	$(call run-in,core,$(CORE_SRC),php bin/console logs:index:setup)

logs-cleanup:
	$(call run-in,core,$(CORE_SRC),php bin/console logs:cleanup)

conventions-test:
	cd $(TEST_ROOT)/agent-conventions && npm install && AGENT_URL=$(AGENT_URL) npx codeceptjs run --steps

devcontainer-up:
	$(DEVCONTAINER_COMPOSE) up -d $(DEVCONTAINER_SERVICE)

devcontainer-shell: devcontainer-up
	$(DEVCONTAINER_COMPOSE) exec $(DEVCONTAINER_SERVICE) bash

e2e-in-devcontainer: devcontainer-up
	$(DEVCONTAINER_COMPOSE) exec -T $(DEVCONTAINER_SERVICE) bash -lc 'cd /workspaces/brama && RUNNING_IN_DEVCONTAINER=1 $(MAKE) e2e-inner'

e2e-smoke-in-devcontainer: devcontainer-up
	$(DEVCONTAINER_COMPOSE) exec -T $(DEVCONTAINER_SERVICE) bash -lc 'cd /workspaces/brama && RUNNING_IN_DEVCONTAINER=1 $(MAKE) e2e-smoke-inner'

e2e-inner: e2e-prepare e2e-env-check
	cd $(TEST_ROOT)/e2e && npm install && npx playwright install chromium --with-deps && \
		$(E2E_ENV_EXPORT) \
		BASE_URL=$${BASE_URL:-$(E2E_BASE_URL)} \
		CORE_DB_NAME=$${CORE_DB_NAME:-$(E2E_CORE_DB)} \
		KNOWLEDGE_URL=$${KNOWLEDGE_URL:-http://localhost:18083} \
		NEWS_URL=$${NEWS_URL:-http://localhost:18084} \
		HELLO_URL=$${HELLO_URL:-http://localhost:18085} \
		OPENCLAW_URL=$${OPENCLAW_URL:-http://localhost:28789} \
		npx codeceptjs run --steps

e2e-smoke-inner: e2e-prepare e2e-env-check
	cd $(TEST_ROOT)/e2e && npm install && \
		$(E2E_ENV_EXPORT) \
		BASE_URL=$${BASE_URL:-$(E2E_BASE_URL)} \
		CORE_DB_NAME=$${CORE_DB_NAME:-$(E2E_CORE_DB)} \
		KNOWLEDGE_URL=$${KNOWLEDGE_URL:-http://localhost:18083} \
		NEWS_URL=$${NEWS_URL:-http://localhost:18084} \
		HELLO_URL=$${HELLO_URL:-http://localhost:18085} \
		OPENCLAW_URL=$${OPENCLAW_URL:-http://localhost:28789} \
		npx codeceptjs run --steps --grep @smoke

e2e:
ifeq ($(IS_DEVCONTAINER),)
	@$(MAKE) e2e-in-devcontainer
else
	@$(MAKE) e2e-inner
endif

e2e-smoke:
ifeq ($(IS_DEVCONTAINER),)
	@$(MAKE) e2e-smoke-in-devcontainer
else
	@$(MAKE) e2e-smoke-inner
endif

verify-local-smoke:
	./scripts/verify-local.sh

verify-local-up:
	$(VERIFY_LOCAL_COMPOSE) up -d --build traefik postgres redis opensearch rabbitmq core core-scheduler litellm website

verify-local: verify-local-smoke e2e

sync-skills:
	./brama-core/scripts/sync-skills.sh

# ── Monitoring Commands ─────────────────────────────────────
monitor-foundry:
	@echo "=== Foundry Monitor ==="
	@echo "Keys: [s] start, [k] kill, [f] retry, [+/-] priority, [q] quit"
	@./agentic-development/foundry.sh

monitor-builder: monitor-foundry

monitor-ultraworks:
	@./agentic-development/ultraworks.sh
	@echo ""
	@echo "Commands:"
	@echo "  make monitor-ultraworks-watch   - Live TUI with agent sidebar"
	@echo "  make monitor-ultraworks-launch  - Start OpenCode in tmux"
	@echo "  make monitor-ultraworks-attach  - Attach to running session"
	@echo "  make monitor-ultraworks-menu    - Interactive menu"

monitor-ultraworks-watch:
	@-./agentic-development/ultraworks.sh watch < /dev/tty

monitor-ultraworks-watch-debug:
	@-./agentic-development/ultraworks.sh watch --debug < /dev/tty

monitor-ultraworks-launch:
	@./agentic-development/ultraworks.sh launch "$(TASK)"

monitor-ultraworks-attach:
	@./agentic-development/ultraworks.sh attach

monitor-ultraworks-menu:
	@./agentic-development/ultraworks.sh menu

# ── Multi-Agent Builder Pipeline ─────────────────────────────────────
foundry:
	@./agentic-development/foundry.sh

foundry-headless:
	@./agentic-development/foundry.sh headless

pipeline:
	@test -n "$(TASK)" || (echo "Usage: make pipeline TASK=\"your task description\"" && exit 1)
	./agentic-development/foundry.sh run "$(TASK)"

pipeline-batch:
	@test -n "$(FILE)" || (echo "Usage: make pipeline-batch FILE=tasks.txt" && exit 1)
	./agentic-development/foundry.sh batch "$(FILE)"

builder-setup:
	./agentic-development/foundry.sh setup

builder-cleanup:
	./agentic-development/foundry.sh cleanup

builder-cleanup-apply:
	./agentic-development/foundry.sh cleanup --apply

# ── Kubernetes / K3S Targets ───────────────────────────────────────────────

k8s-ctx:
	@kubectl config current-context
	@kubectl cluster-info --short 2>/dev/null || kubectl cluster-info

k8s-ns:
	@kubectl get ns $(K8S_NAMESPACE) 2>/dev/null || kubectl create namespace $(K8S_NAMESPACE)
	@echo "Namespace: $(K8S_NAMESPACE)"

k8s-deps:
	cd $(HELM_CHART) && helm dependency update

# ── Build & Load images into K3S containerd ───────────────────────────────

k8s-build:
	@echo "Building core..."
	docker build -t $(K8S_CORE_IMAGE) -f brama-core/Dockerfile brama-core
	@echo "Building hello-agent..."
	docker build -t $(K8S_HELLO_IMAGE) brama-agents/hello-agent/

k8s-load:
	docker save $(K8S_CORE_IMAGE) | rdctl shell sudo k3s ctr images import -
	docker save $(K8S_HELLO_IMAGE) | rdctl shell sudo k3s ctr images import -
	@echo "Images imported into K3S containerd"

# ── Secrets ───────────────────────────────────────────────────────────────

k8s-secrets: k8s-ns
	@kubectl get secret brama-core-secrets -n $(K8S_NAMESPACE) 2>/dev/null && echo "Secret brama-core-secrets already exists (use kubectl delete secret to recreate)" || \
		kubectl create secret generic brama-core-secrets -n $(K8S_NAMESPACE) \
			--from-literal=APP_SECRET=$$(openssl rand -hex 16) \
			--from-literal=EDGE_AUTH_JWT_SECRET=$$(openssl rand -hex 32) \
			--from-literal=DATABASE_URL="postgresql://app:app@$(HELM_RELEASE)-postgresql:5432/ai_community_platform?serverVersion=16&charset=utf8" \
			--from-literal=REDIS_URL="redis://$(HELM_RELEASE)-redis-master:6379" \
			--from-literal=RABBITMQ_URL="amqp://app:app@$(HELM_RELEASE)-rabbitmq:5672" \
			--from-literal=POSTGRES_PROVISIONER_URL="postgresql://app:app@$(HELM_RELEASE)-postgresql:5432/ai_community_platform?serverVersion=16&charset=utf8"
	@echo "Secrets ready in namespace $(K8S_NAMESPACE)"

# ── Full setup: build + load + secrets + deploy ───────────────────────────

k8s-setup: k8s-build k8s-load k8s-secrets k8s-deploy
	@echo ""
	@echo "K3S deployment complete. Run 'make k8s-status' to check."

# ── Deploy / Upgrade ──────────────────────────────────────────────────────

k8s-deploy: k8s-ns k8s-deps
	helm upgrade --install $(HELM_RELEASE) $(HELM_CHART) \
		--namespace $(K8S_NAMESPACE) \
		-f $(K8S_VALUES) \
		--wait --timeout 5m

k8s-upgrade: k8s-deps
	helm upgrade $(HELM_RELEASE) $(HELM_CHART) \
		--namespace $(K8S_NAMESPACE) \
		-f $(K8S_VALUES) \
		--wait --timeout 5m

k8s-diff: k8s-deps
	helm diff upgrade $(HELM_RELEASE) $(HELM_CHART) \
		--namespace $(K8S_NAMESPACE) \
		-f $(K8S_VALUES) 2>/dev/null || \
		helm upgrade --install $(HELM_RELEASE) $(HELM_CHART) \
			--namespace $(K8S_NAMESPACE) \
			-f $(K8S_VALUES) --dry-run

# ── Observe ───────────────────────────────────────────────────────────────

k8s-status:
	@echo "=== Pods ==="
	@kubectl get pods -n $(K8S_NAMESPACE) -o wide
	@echo ""
	@echo "=== Services ==="
	@kubectl get svc -n $(K8S_NAMESPACE)
	@echo ""
	@echo "=== Ingress ==="
	@kubectl get ingress -n $(K8S_NAMESPACE) 2>/dev/null || true
	@echo ""
	@echo "=== Helm Release ==="
	@helm status $(HELM_RELEASE) -n $(K8S_NAMESPACE) 2>/dev/null | sed -n '1,8p' || echo "Release not found"

k8s-logs:
	@test -n "$(svc)" || (echo "Usage: make k8s-logs svc=core|core-scheduler|agent-hello" && exit 1)
	kubectl logs -n $(K8S_NAMESPACE) -l app.kubernetes.io/component=$(svc) -f --tail=100

k8s-logs-all:
	kubectl logs -n $(K8S_NAMESPACE) -l app.kubernetes.io/instance=$(HELM_RELEASE) -f --tail=50 --max-log-requests=10

k8s-shell:
	@test -n "$(svc)" || (echo "Usage: make k8s-shell svc=core|core-scheduler|agent-hello" && exit 1)
	kubectl exec -it -n $(K8S_NAMESPACE) $$(kubectl get pod -n $(K8S_NAMESPACE) -l app.kubernetes.io/component=$(svc) -o jsonpath='{.items[0].metadata.name}') -- /bin/sh

k8s-destroy:
	helm uninstall $(HELM_RELEASE) -n $(K8S_NAMESPACE)
	@echo "Release $(HELM_RELEASE) uninstalled from namespace $(K8S_NAMESPACE)"

k8s-port-forward:
	@test -n "$(svc)" || (echo "Usage: make k8s-port-forward svc=core|agent-hello port=8080:80" && exit 1)
	@test -n "$(port)" || (echo "Usage: make k8s-port-forward svc=core|agent-hello port=8080:80" && exit 1)
	kubectl port-forward -n $(K8S_NAMESPACE) svc/$(HELM_RELEASE)-$(svc) $(port)
