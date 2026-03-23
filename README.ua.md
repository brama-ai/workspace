# Brama Workspace

[🇺🇸 English version](README.md)

`brama-workspace` це локальний workspace-репозиторій для платформи Brama. Він відповідає за devcontainer, Docker Compose топологію, локальні env-шаблони, bootstrap-скрипти та helper-команди для розробника.

Код застосунків живе в [`core`](/Users/nmdimas/work/brama-workspace/core), який залишається окремим Git-репозиторієм. Цей repo відповідає не за продуктову логіку, а за те, як уся платформа піднімається і працює на машині розробника.

## Структура Репозиторію

- [`.devcontainer/`](/Users/nmdimas/work/brama-workspace/.devcontainer) містить образ devcontainer, lifecycle hooks і bootstrap helper-и.
- [`docker/`](/Users/nmdimas/work/brama-workspace/docker) містить усі Docker Compose файли (`compose.yaml`, `compose.*.yaml`), Dockerfile-и та спільні Docker-асети.
- [`scripts/`](/Users/nmdimas/work/brama-workspace/scripts) містить bootstrap та operator helper scripts.
- [`Makefile`](/Users/nmdimas/work/brama-workspace/Makefile) є головною точкою входу для щоденних команд.
- [`core/`](/Users/nmdimas/work/brama-workspace/core) містить продуктовий код, тести, документацію та app-рівневі ресурси.

## Вимоги

Для запуску з хоста:

- Docker Desktop або Docker Engine з Compose v2
- Git
- GNU Make

Для devcontainer workflow:

- VS Code з розширенням Dev Containers
- Docker Desktop або Docker Engine з Compose v2

Додатково корисно мати:

- `curl`
- `jq`
- `gh`

## Старт

Рекомендований перший open-source сценарій: підняти `core` тільки з його storage-level залежностями:

- PostgreSQL
- Redis

Після того як цей мінімальний шлях працює, можна переходити до повного Docker Compose стеку або до Helm chart у Kubernetes.

### 1. Local Development через `.devcontainer`

Рекомендований шлях, якщо потрібен відтворюваний toolchain і ти хочеш розробляти `core` напряму з source code.

```bash
git clone <workspace-repo>
cd brama-workspace

cp .env.local.example .env.local
make bootstrap

# відкрий папку у VS Code і вибери "Reopen in Container"
```

Всередині devcontainer почни з `core + postgres + redis`:

```bash
cd core/src
composer install
php bin/console doctrine:migrations:migrate --no-interaction
php bin/console server:start
```

Нотатки:

- devcontainer сидить у тій самій Docker мережі, що і `postgres` та `redis`
- `DATABASE_URL` і `REDIS_URL` вже вказують на Docker hostname-и
- це найзручніший шлях, якщо спочатку хочеш просто підняти storage-backed `core` і редагувати код live

Коли потрібен більший workspace stack:

```bash
make setup
make sync-skills
```

### 2. `.docker compose` Setup

Використовуй це, якщо хочеш запускати платформу контейнерами з хоста без входу в devcontainer.

Мінімальний сценарій `core + postgres + redis`:

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

Доступ:

- `http://localhost`
- fallback напряму: `http://localhost:8081`

Коли потрібен повний локальний bundle, а не мінімальний storage-backed запуск:

```bash
make setup
make sync-skills
make up
make litellm-db-init
make migrate
```

### 3. Kubernetes інсталяція через Chart Values

Використовуй це, якщо хочеш запускати платформу в Kubernetes через Helm chart і values-файли.

Розташування chart:

- [Brama Helm chart](/Users/nmdimas/work/brama-workspace/core/deploy/charts/brama)

Корисні values-файли:

- локальний K3s/dev профіль: [values-k3s-dev.yaml](/Users/nmdimas/work/brama-workspace/core/deploy/charts/brama/values-k3s-dev.yaml)
- production-oriented приклад: [values-prod.example.yaml](/Users/nmdimas/work/brama-workspace/core/deploy/charts/brama/values-prod.example.yaml)

Для локального K3s через workspace helper-и:

```bash
make k8s-build
make k8s-load
make k8s-secrets
make k8s-deploy
make k8s-status
```

Зараз цей профіль деплоїть:

- `core`
- `core-scheduler`
- `hello-agent`
- PostgreSQL
- Redis
- RabbitMQ

Прямий Helm install:

```bash
helm upgrade --install brama core/deploy/charts/brama \
  --namespace brama \
  --create-namespace \
  -f core/deploy/charts/brama/values-k3s-dev.yaml \
  --wait --timeout 5m
```

Для не-локального кластера краще стартувати з `values-prod.example.yaml` і підставити свої образи, секрети, ingress hostnames та persistence policy.

## Щоденний Workflow

### Підняти або зупинити стек

```bash
make up
make down
make ps
```

### Встановити залежності

```bash
make install
make knowledge-install
make hello-install
make dev-agent-install
make dev-reporter-install
make news-install
make wiki-install
```

### Запустити тести і перевірки

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

### Логи і дебаг

```bash
make logs
make logs-core
make logs-traefik
make logs-litellm
make logs-openclaw
make logs-langfuse
```

### Smoke та E2E перевірки

```bash
make verify-local-up
make verify-local-smoke
make e2e-smoke
make e2e
```

## Env Файли

- [`.env.local.example`](/Users/nmdimas/work/brama-workspace/.env.local.example) це основний локальний шаблон. Скопіюйте його в `.env.local`.
- [`.env.deployment.example`](/Users/nmdimas/work/brama-workspace/.env.deployment.example) документує deployment-oriented overrides.
- `docker/openclaw/.env` генерується через `make bootstrap` і має лишатися локальним.

Кращі практики:

- Зберігайте секрети тільки в локальних `.env` файлах.
- Сприймайте `.env.local` як developer-specific state.
- Після зміни provider credentials або OpenClaw secret-ів повторно запускайте `make bootstrap`.

## Основні Команди

У workspace є невеликий набір базових точок входу:

- `make bootstrap`: згенерувати і розкласти локальні runtime secrets.
- `make setup`: підготувати залежності та build prerequisites.
- `make up`: підняти локальну платформу.
- `make down`: зупинити локальну платформу.
- `make migrate`: прогнати міграції core.
- `make test`: запустити основні автоматизовані тести core.
- `make e2e`: запустити повний end-to-end набір.
- `make help`: показати повний каталог команд.

## Compose Модель

Усі Compose-файли знаходяться в директорії `docker/`:

- [`docker/compose.yaml`](/Users/nmdimas/work/brama-workspace/docker/compose.yaml): спільна інфраструктура на кшталт Traefik, Postgres, Redis, OpenSearch, RabbitMQ та LiteLLM.
- [`docker/compose.core.yaml`](/Users/nmdimas/work/brama-workspace/docker/compose.core.yaml): core-сервіси платформи.
- `docker/compose.agent-*.yaml`: агенти платформи та їхні локальні dev-сервіси.
- [`docker/compose.openclaw.yaml`](/Users/nmdimas/work/brama-workspace/docker/compose.openclaw.yaml): OpenClaw gateway і CLI.
- [`docker/compose.langfuse.yaml`](/Users/nmdimas/work/brama-workspace/docker/compose.langfuse.yaml): observability сервіси.
- `docker/compose.fragments/`: compose-фрагменти зовнішніх агентів.

[`Makefile`](/Users/nmdimas/work/brama-workspace/Makefile) збирає повний стек автоматично, тому для рутини краще використовувати `make` targets, а не писати вручну довгі `docker compose -f ...` команди.

## Нотатки По Devcontainer

Devcontainer розрахований на workspace-рівень:

- монтує весь workspace у `/workspaces/brama`
- використовує ту саму Compose топологію, що і host workflow
- прокидає `.env.local` всередину container runtime
- містить PHP, Node, Bun, Playwright, Docker CLI, Composer, Go, Claude Code і OpenCode

Якщо змінюєш image-level devcontainer assets, краще rebuild контейнер, а не намагатися лікувати вже запущене середовище вручну.

## Робота З `core`

`core` це продуктовий репозиторій. Типовий приклад:

```bash
cd core
git status
```

Workspace repo і `core` repo навмисно незалежні. Infra/runtime зміни комітяться в workspace repo, а продуктові зміни комітяться в `core`.

## Кращі Практики

- Для рутинних задач використовуйте `make` targets, а не сирі `docker compose` команди.
- Workspace-рівневі зміни тримайте в цьому репозиторії, app-рівневі в `core`.
- Використовуйте devcontainer, коли потрібен відтворюваний toolchain або Playwright-ready environment.
- Перед великим E2E запуском проганяйте `make verify-local-smoke`, якщо потрібна швидка runtime-перевірка.
- Не комітьте локальний згенерований state на кшталт `.env.local`, `.local/` або `docker/openclaw/.env`.
- При дебазі сервісних зв’язків починайте з `make ps`, а потім дивіться targeted `make logs-*`.

## Troubleshooting

### Проблеми з compose paths або build

Запустіть:

```bash
docker compose --project-directory . -f docker/compose.yaml -f docker/compose.core.yaml config
```

Якщо команда падає, найчастіше проблема у зламаному відносному шляху в compose-файлі або Dockerfile.

### Проблеми з OpenClaw або provider setup

Запустіть:

```bash
make bootstrap
make logs-openclaw
```

### LiteLLM UI показує database-related errors

Запустіть:

```bash
make litellm-db-init
```

### Після змін у devcontainer щось не зійшлося

Запустіть:

```bash
make setup
```

або перебудуйте devcontainer, якщо проблема на рівні image, а не project state.

## Пов’язані Репозиторії

- [`core`](/Users/nmdimas/work/brama-workspace/core): application source code, тести та продуктова документація.
