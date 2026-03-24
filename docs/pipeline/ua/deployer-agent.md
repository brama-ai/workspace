# Агент Deployer

Deployer — це **Фаза 8** пайплайну AI Community Platform — агент з явним увімкненням, який бере завершені та перевірені зміни і деплоїть їх до цільового середовища.

## Огляд

Deployer закриває "останню милю" пайплайну. Після проходження всіх перевірок якості (Validator, Tester, Auditor, Summarizer), deployer може відправити зміни до продакшену за допомогою однієї з чотирьох стратегій.

**Ключові властивості:**
- Тільки явне увімкнення — ніколи не запускається автоматично
- Dry-run за замовчуванням — показує заплановані дії без виконання
- Вимагає проходження всіх попередніх фаз
- Ніколи не робить force-push до жодної гілки

## Позиція в пайплайні

```
Planner → Architect → Coder → Validator → Tester → Documenter → Summarizer → [Deployer]
                                                                               ↑
                                                                     Фаза 8 (явне увімкнення)
```

## Активація

Deployer запускається тільки коли **обидві** умови виконані:

1. Метадані задачі містять `deploy: true`
2. Всі попередні фази пайплайну (Фази 1–7) завершились успішно

Якщо будь-яка умова не виконана, deployer пропускає виконання і повідомляє причину.

## Стратегії деплойменту

| Стратегія | Опис | Коли використовувати |
|-----------|------|----------------------|
| `pr-only` | Push гілки + створення GitHub PR | За замовчуванням, найбезпечніша — без доступу до сервера |
| `merge-and-deploy` | Створення PR + auto-merge + очікування CI деплою | Коли CI/CD обробляє деплоймент |
| `direct-ssh` | SSH до сервера, git pull, docker compose up | Застарілі Docker Compose сервери |
| `helm-upgrade` | SSH до сервера, helm upgrade з новим тегом образу | K3s/Kubernetes сервери |

### `pr-only` (За замовчуванням)

Відправляє поточну гілку та створює GitHub PR. Доступ до сервера не потрібен.

```bash
git push origin HEAD
gh pr create --title "<назва задачі>" --body "<підсумок>"
```

URL PR повідомляється в handoff пайплайну.

### `merge-and-deploy`

Створює PR, вмикає auto-merge та очікує завершення CI деплою.

```bash
gh pr create ...
gh pr merge --auto --squash
gh pr checks --watch
curl -f <health_endpoint>  # перевірка після CI деплою
```

### `direct-ssh`

Підключається до цільового сервера через MCP SSH, отримує останні зміни та перебудовує.

```bash
# На сервері:
cd <APP_PATH>
git pull origin <branch>
docker compose up -d --build
curl -f <health_endpoint>  # перевірка здоров'я
```

Вимагає SSH конфігурацію в `.devcontainer/.ssh-env`.

### `helm-upgrade`

Підключається до K3s/Kubernetes сервера та оновлює Helm реліз.

```bash
# На сервері:
helm upgrade --install <release> <chart> --set image.tag=<tag> --wait
kubectl rollout status deployment/<name>
curl -f <health_endpoint>  # перевірка здоров'я
```

Вимагає SSH конфігурацію в `.devcontainer/.ssh-env`.

## Конфігурація

### Метадані задачі

Додайте до вашого `task.md` для увімкнення деплойменту:

```yaml
---
deploy: true
deploy_strategy: pr-only        # pr-only | merge-and-deploy | direct-ssh | helm-upgrade
dry_run: false                  # за замовчуванням: true (dry-run режим)
health_endpoint: http://...     # обов'язково для direct-ssh, helm-upgrade, merge-and-deploy
---
```

### SSH конфігурація (`.devcontainer/.ssh-env`)

Обов'язково для стратегій `direct-ssh` та `helm-upgrade`:

```bash
SSH_HOST=<hostname-або-ip-сервера>
SSH_USER=<ім'я-користувача>
SSH_PORT=22
APP_PATH=/шлях/до/застосунку
HEALTH_ENDPOINT=http://<host>/health
```

## Захисні шлюзи

Deployer застосовує п'ять захисних шлюзів:

| Шлюз | Правило |
|------|---------|
| **Явне увімкнення** | `deploy: true` має бути в метаданих задачі |
| **Dry-run за замовчуванням** | Запускається в dry-run режимі якщо не встановлено `dry_run: false` |
| **Перевірка фаз** | Всі попередні фази пайплайну мають пройти успішно |
| **Без force-push** | Тільки звичайний `git push` — відхилений push = зупинка |
| **Без непідтвердженого продакшену** | Деплой до продакшену вимагає явного підтвердження |

## Dry-Run режим

За замовчуванням deployer запускається в dry-run режимі та показує що він зробив би:

```
[DRY-RUN] Would push branch: pipeline/my-feature
[DRY-RUN] Would create PR: "Додати підтримку стрімінгу до A2A gateway"
[DRY-RUN] No changes executed.
```

Для реального виконання встановіть `dry_run: false` в метаданих задачі.

## Процедури відкату

### `pr-only`
Закрийте PR. Стан сервера не змінювався.

### `merge-and-deploy`
```bash
git revert <merge-commit>
git push origin main
# CI перерозгорне попередній стан
```

### `direct-ssh`
```bash
# SSH до сервера
cd <APP_PATH>
git revert HEAD
docker compose up -d --build
curl -f <health_endpoint>
```

### `helm-upgrade`
```bash
# SSH до сервера
helm history <release-name>
helm rollback <release-name> <попередня-ревізія>
kubectl rollout status deployment/<name>
curl -f <health_endpoint>
```

## Вимоги до середовища

| Вимога | Стратегії | Примітки |
|--------|-----------|----------|
| `gh` CLI | `pr-only`, `merge-and-deploy` | GitHub CLI для створення PR |
| SSH конфіг в `.ssh-env` | `direct-ssh`, `helm-upgrade` | MCP SSH агент читає цей файл |
| `helm` + `kubectl` на сервері | `helm-upgrade` | Мають бути встановлені на цільовому сервері |
| Health endpoint | `direct-ssh`, `helm-upgrade`, `merge-and-deploy` | Для перевірки після деплою |

## Вивід у handoff

Deployer додає до `.opencode/pipeline/handoff.md`:

```markdown
## Deployer

- **Status**: deployed | dry-run | skipped | failed
- **Strategy**: pr-only
- **Dry-run**: true
- **Actions taken**:
  - [DRY-RUN] Would push branch: pipeline/my-feature
  - [DRY-RUN] Would create PR: "Моя фіча"
- **PR URL**: https://github.com/org/repo/pull/123
- **Health check**: skipped (dry-run)
- **Rollback plan**: Закрити PR
```

## Файли агента

| Файл | Призначення |
|------|-------------|
| `.opencode/agents/deployer.md` | Визначення основного агента (Foundry) |
| `.opencode/agents/s-deployer.md` | Обгортка субагента (Ultraworks/Sisyphus) |
| `.opencode/skills/deployer/SKILL.md` | Повні робочі процеси стратегій та захисні шлюзи |

## Пов'язана документація

- [Робочий процес пайплайну](../agent-development/en/workflow.md) — повний огляд пайплайну
- [Foundry](../agent-development/en/foundry.md) — рантайм Foundry
- [Ultraworks](../agent-development/en/ultraworks.md) — рантайм Ultraworks
