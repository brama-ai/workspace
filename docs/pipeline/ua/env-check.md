# Перевірка оточення — `env-check.json`

Foundry Monitor та pipeline runner перевіряють середовище розробки перед запуском будь-якої задачі. Конфігурація **per-project** і живе у файлі `env-check.json` в корені проекту.

## Навіщо

Запуск pipeline на зламаному оточенні — це втрата часу та грошей (токени LLM). Перевірка оточення ловить проблеми **до** старту першого агента:

- Docker не запущений
- Потрібні сервіси (postgres, redis) зупинені або unhealthy
- Відсутні CLI інструменти
- HTTP endpoint'и недоступні

## Де це видно в TUI

Заголовок Foundry Monitor показує індикатор ENV в реальному часі:

```
  Foundry Monitor v2.5.0  14:30:00  ● ENV (8 services)              ← все ок
  Foundry Monitor v2.5.0  14:30:00  ✗ ENV postgres: exited  [e] up  ← проблеми
  Foundry Monitor v2.5.0  14:30:00  ? ENV env-check.json missing    ← немає конфігу
```

- `●` зелений — оточення готове
- `✗` червоний — знайдені проблеми (до 3 причин)
- `?` жовтий — `env-check.json` не знайдено

Натисніть `[e]` щоб запустити `docker compose up -d` і підняти оточення.

## Розташування файлу

```
<корінь-проекту>/env-check.json
```

Кожен проект, що використовує Foundry pipelines, **повинен** мати цей файл. Якщо файл відсутній, TUI показує попередження, а pipeline runner відмовляється запускати задачі.

## Схема

```jsonc
{
  // Docker Compose файли (відносно кореня проекту)
  "compose_files": [
    "docker/compose.yaml",
    "docker/compose.core.yaml"
  ],

  // Сервіси, які МАЮТЬ працювати. Pipeline зафейлиться якщо будь-який не працює.
  "required_services": [
    { "name": "postgres",  "healthcheck": true },
    { "name": "redis",     "healthcheck": true },
    { "name": "rabbitmq",  "healthcheck": true }
  ],

  // Сервіси, які перевіряються але не блокують pipeline
  "optional_services": [
    "traefik",
    "litellm"
  ],

  // HTTP endpoint'и для перевірки (curl -sf)
  "healthcheck_urls": [
    { "url": "http://localhost:8080/api", "label": "Traefik", "required": false },
    { "url": "http://localhost:15672",    "label": "RabbitMQ UI", "required": false }
  ],

  // Shell команди для перевірки наявності інструментів
  "commands": [
    { "cmd": "docker info",   "label": "Docker daemon",  "required": true },
    { "cmd": "git --version", "label": "Git",            "required": true },
    { "cmd": "php -v",        "label": "PHP",            "required": true }
  ],

  // Команда для запуску оточення (використовується кнопкою [e] в TUI)
  "up_command": "docker compose -f docker/compose.yaml -f docker/compose.core.yaml up -d"
}
```

## Опис полів

### `compose_files`

**Обов'язкове.** Масив шляхів до Docker Compose файлів відносно кореня проекту. Використовується для:
- Запиту статусу сервісів (`docker compose ps`)
- Побудови команди `up` (якщо `up_command` не задано)

```json
"compose_files": ["docker/compose.yaml"]
```

### `required_services`

**Обов'язкове.** Масив сервісів, які мають працювати для запуску pipeline. Кожен елемент — рядок або об'єкт:

```json
// Просто перевірити що запущений
"required_services": ["postgres", "redis"]

// З healthcheck — має бути запущений І здоровий
"required_services": [
  { "name": "postgres", "healthcheck": true },
  { "name": "redis",    "healthcheck": true }
]
```

Коли `healthcheck: true`, сервіс повинен мати статус `healthy` (Docker healthcheck). Сервіси зі статусом `running` але `unhealthy` або `starting` не пройдуть перевірку.

### `optional_services`

Необов'язкове. Масив імен сервісів для відображення в статусі без блокування. Корисно для моніторингу — ви бачите їх в TUI, але вони не заважають запуску задач.

### `healthcheck_urls`

Необов'язкове. Масив HTTP endpoint'ів для перевірки через `curl -sf --max-time 3`:

| Поле | Тип | Опис |
|------|-----|------|
| `url` | string | Повний URL для перевірки |
| `label` | string | Людино-читаблива назва для повідомлень про помилки |
| `required` | boolean | `true` = pipeline зафейлиться якщо недоступний |

### `commands`

Необов'язкове. Масив shell команд для виконання. Корисно для перевірки наявності `php`, `node`, `composer`:

| Поле | Тип | Опис |
|------|-----|------|
| `cmd` | string | Shell команда для виконання |
| `label` | string | Людино-читаблива назва для повідомлень про помилки |
| `required` | boolean | `true` = pipeline зафейлиться якщо команда не спрацює |

Примітка: `docker info` перевіряється автоматично — можна додати в `commands` для документації, але він завжди перевіряється першим.

### `up_command`

Необов'язкове. Користувацька команда для запуску оточення. Використовується при натисканні `[e]` в TUI. Якщо не задано, команда будується з `compose_files`:

```
docker compose -f <file1> -f <file2> ... up -d
```

## Як працює перевірка

Env-check запускається у двох точках:

### 1. TUI (кожні 30 секунд, async)

```
checkEnvStatusAsync(repoRoot, callback)
```

Неблокуючий. Оновлює індикатор у заголовку без заморозки UI.

### 2. Pipeline runner (перед першим агентом, sync)

```
runPipeline(config)
  └─ if (!config.skipEnvCheck)
       └─ checkEnvStatus(repoRoot)
            └─ if not ready → зафейлити задачу з помилкою "env-check"
```

Послідовність перевірки:

1. **Завантажити конфіг** — прочитати `env-check.json` (помилка якщо відсутній)
2. **Docker daemon** — `docker info` (помилка якщо не запущений)
3. **Команди** — виконати кожну з `commands[]`
4. **Compose сервіси** — `docker compose ps --format json --all`
5. **Required сервіси** — перевірити що кожен запущений (+ healthy якщо налаштовано)
6. **Healthcheck URL** — `curl -sf` для кожного required URL

Якщо будь-яка required перевірка зафейлилась, задача отримує статус `failed` з `failedAgent: "env-check"`, а помилки записуються в `handoff.md`.

## Пропуск перевірки

Для рідкісних випадків коли потрібно запустити pipeline без валідації оточення:

```bash
foundry run --skip-env-check "My task"
```

Або в конфігурації pipeline:

```typescript
const config: PipelineConfig = {
  skipEnvCheck: true,
  // ...
};
```

## Приклади

### Мінімальний (тільки сервіси)

```json
{
  "compose_files": ["docker/compose.yaml"],
  "required_services": ["postgres", "redis"]
}
```

### Повний стек з агентами

```json
{
  "compose_files": [
    "docker/compose.yaml",
    "docker/compose.core.yaml"
  ],
  "required_services": [
    { "name": "postgres",  "healthcheck": true },
    { "name": "redis",     "healthcheck": true },
    { "name": "rabbitmq",  "healthcheck": true }
  ],
  "optional_services": [
    "traefik",
    "litellm",
    "opensearch"
  ],
  "healthcheck_urls": [
    { "url": "http://localhost:15672", "label": "RabbitMQ management", "required": false }
  ],
  "commands": [
    { "cmd": "docker info",   "label": "Docker daemon",  "required": true },
    { "cmd": "git --version", "label": "Git",            "required": true }
  ],
  "up_command": "docker compose -f docker/compose.yaml -f docker/compose.core.yaml up -d"
}
```

### Python проект (без compose)

```json
{
  "compose_files": [],
  "required_services": [],
  "commands": [
    { "cmd": "python3 --version", "label": "Python 3",  "required": true },
    { "cmd": "pip --version",     "label": "pip",        "required": true }
  ]
}
```

### Node.js агент

```json
{
  "compose_files": ["docker-compose.yml"],
  "required_services": [
    { "name": "mongo", "healthcheck": true }
  ],
  "commands": [
    { "cmd": "node --version", "label": "Node.js", "required": true },
    { "cmd": "npm --version",  "label": "npm",     "required": true }
  ]
}
```

## Розв'язання проблем

### `? ENV env-check.json missing`

Створіть `env-check.json` в корені проекту. Дивіться приклади вище.

### `✗ ENV postgres: exited`

Сервіс існує але не запущений. Натисніть `[e]` в TUI або виконайте:

```bash
docker compose -f docker/compose.yaml up -d postgres
```

### `✗ ENV redis: unhealthy`

Сервіс запущений але healthcheck не проходить. Перевірте логи контейнера:

```bash
docker compose -f docker/compose.yaml logs redis
```

### `✗ ENV No compose services found`

Docker Compose стек ніколи не був запущений. Натисніть `[e]` або виконайте `up_command` з вашого конфігу.

### Pipeline зафейлився з `failedAgent: "env-check"`

Оточення не було готове при старті pipeline. Виправте проблеми зазначені в `handoff.md`, потім перезапустіть задачу.
