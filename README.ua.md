# Brama Workspace

[🇺🇸 English version](README.md)

`brama-workspace` це runtime shell для платформи Brama. Він відповідає за deployment та developer runtime: Docker Compose топологію, devcontainer, локальні env-шаблони, bootstrap-скрипти та helper-команди для оператора і розробника.

Код застосунків живе в [`core`](/Users/nmdimas/work/brama-workspace/brama-core), який залишається окремим Git-репозиторієм. Цей repo відповідає не за продуктову логіку, а за те, як уся платформа збирається і запускається — чи то на одній машині, чи то в кластері.

## Runtime Modes (Режими Запуску)

Workspace підтримує три runtime modes. Кожен режим має своє призначення та аудиторію:

| Режим | Призначення | Аудиторія | Точка входу |
|-------|-------------|-----------|-------------|
| **Docker Compose** | Основний single-node deployment | Оператори, розробники | `make up` |
| **Devcontainer** | Development overlay поверх Compose | Розробники | VS Code → "Reopen in Container" |
| **k3s / Kubernetes** | Cluster-oriented deployment | Оператори, SRE | `make k8s-setup` або Helm |

**Docker Compose** — це baseline. Найшвидший шлях запустити всю платформу на одній машині. Усі інші режими або будуються поверх нього, або замінюють його для кластерних сценаріїв.

**Devcontainer** — це development overlay, а не незалежна deployment topology. Він використовує ту саму Docker Compose інфраструктуру (Postgres, Redis тощо) і додає поверх неї відтворюваний developer toolchain. Запуск devcontainer не замінює Docker Compose — він розширює його інтерактивним середовищем розробки.

**k3s / Kubernetes** — це cluster-oriented deployment mode. Використовує Helm charts і values-файли замість Docker Compose. Обирайте цей режим, коли потрібен multi-node deployment, production-grade оркестрація або Kubernetes-native інструменти. Workspace надає `make k8s-*` helper-и для локальної k3s розробки з Rancher Desktop.

## Структура Репозиторію

- [`.devcontainer/`](/Users/nmdimas/work/brama-workspace/.devcontainer) містить образ devcontainer, lifecycle hooks і bootstrap helper-и.
- [`docker/`](/Users/nmdimas/work/brama-workspace/docker) містить усі Docker Compose файли (`compose.yaml`, `compose.*.yaml`), Dockerfile-и та спільні Docker-асети.
- [`scripts/`](/Users/nmdimas/work/brama-workspace/scripts) містить bootstrap та operator helper scripts.
- [`Makefile`](/Users/nmdimas/work/brama-workspace/Makefile) є головною точкою входу для щоденних команд.
- [`brama-core/`](/Users/nmdimas/work/brama-workspace/brama-core) містить продуктовий код, тести, документацію та app-рівневі ресурси.

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

### 1. Docker Compose (основний single-node deployment)

Docker Compose — це найшвидший шлях запустити платформу на одній машині. Використовуйте цей режим, якщо хочете запускати платформу контейнерами з хоста.

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

### 2. Devcontainer (development overlay поверх Compose)

Devcontainer — це development overlay поверх Docker Compose, а не незалежна deployment topology. Він використовує ту саму Compose-інфраструктуру і додає відтворюваний developer toolchain.

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
cd brama-core/src
composer install
php bin/console doctrine:migrations:migrate --no-interaction
php bin/console server:start
```

Нотатки:

- Devcontainer сидить у тій самій Docker мережі, що і `postgres` та `redis` — це overlay поверх Compose стеку, а не його заміна.
- `DATABASE_URL` і `REDIS_URL` вже вказують на Docker hostname-и.
- Це найзручніший шлях, якщо спочатку хочеш просто підняти storage-backed `core` і редагувати код live.

Коли потрібен більший workspace stack:

```bash
make setup
make sync-skills
```

### 3. k3s / Kubernetes (cluster-oriented deployment)

Використовуйте цей режим, якщо хочете запускати платформу в Kubernetes через Helm chart і values-файли. Цей режим замінює Docker Compose на Helm-based оркестрацію.

Повні operator guides:

- [Kubernetes install guide (UA)](/workspaces/brama/brama-core/docs/guides/deployment/ua/kubernetes-install.md)
- [Kubernetes upgrade guide (UA)](/workspaces/brama/brama-core/docs/guides/deployment/ua/kubernetes-upgrade.md)

Розташування chart:

- [Brama Helm chart](/Users/nmdimas/work/brama-workspace/brama-core/deploy/charts/brama)

Корисні values-файли:

- локальний K3s/dev профіль: [values-k3s-dev.yaml](/Users/nmdimas/work/brama-workspace/brama-core/deploy/charts/brama/values-k3s-dev.yaml)
- production-oriented приклад: [values-prod.example.yaml](/Users/nmdimas/work/brama-workspace/brama-core/deploy/charts/brama/values-prod.example.yaml)

Для локального K3s через workspace helper-и:

```bash
make k8s-build
make k8s-load
make k8s-secrets
make k8s-deploy
make k8s-status
```

Найшвидший шлях:

```bash
make k8s-ctx
make k8s-setup
make k8s-port-forward svc=core port=8080:80
curl -sf http://localhost:8080/health
```

> `make k8s-load` зараз очікує локальний K3s у Rancher Desktop і використовує `rdctl`.
> Якщо у вас `kind`, `minikube` або віддалений кластер, краще йти через прямий Helm install і
> власний спосіб доставки образів.

Зараз цей профіль деплоїть:

- `core`
- `core-scheduler`
- `hello-agent`
- PostgreSQL
- Redis
- RabbitMQ

Прямий Helm install:

```bash
helm upgrade --install brama brama-core/deploy/charts/brama \
  --namespace brama \
  --create-namespace \
  -f brama-core/deploy/charts/brama/values-k3s-dev.yaml \
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

Devcontainer — це development overlay поверх Docker Compose стеку, а не окремий deployment mode:

- монтує весь workspace у `/workspaces/brama`
- використовує ту саму Compose-інфраструктуру (Postgres, Redis тощо)
- прокидає `.env.local` всередину container runtime
- містить PHP, Node, Bun, Playwright, Docker CLI, Composer, Go, Claude Code і OpenCode

Якщо змінюєш image-level devcontainer assets, краще rebuild контейнер, а не намагатися лікувати вже запущене середовище вручну.

## Робота З `core`

`core` це продуктовий репозиторій. Типовий приклад:

```bash
cd brama-core
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

- [`core`](/Users/nmdimas/work/brama-workspace/brama-core): application source code, тести та продуктова документація.
