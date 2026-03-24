# Налаштування Workspace

Повний гайд по клонуванню, конфігурації та початку роботи з платформою Brama.

## Передумови

| Інструмент | Версія | Примітки |
|------------|--------|----------|
| Docker Desktop / Engine | Compose v2 | Обов'язковий для всіх шляхів |
| Git | 2.30+ | Рекомендовано SSH ключ |
| VS Code | Останній | З розширенням Dev Containers |
| GNU Make | 3.81+ | Є в macOS/Linux |

Опціонально: `curl`, `jq`, `gh` (GitHub CLI).

## 1. Клонування репозиторію

```bash
# SSH (рекомендовано — потрібен для submodules)
git clone git@github.com:<org>/brama-workspace.git
cd brama-workspace

# Ініціалізація субмодулів (brama-core, brama-agents)
git submodule update --init --recursive
```

> **Порада:** Якщо бачите помилки доступу, переконайтесь що SSH ключ додано на GitHub:
> `ssh -T git@github.com` має повернути "Hi <user>!".

## 2. Конфігурація середовища

```bash
cp .env.local.example .env.local
```

Відкрийте `.env.local` та заповніть API ключі:

### LLM Провайдери (потрібен мінімум один)

| Провайдер | Змінна | Примітки |
|-----------|--------|----------|
| OpenRouter | `OPENROUTER_API_KEY` | Рекомендовано — один ключ, багато моделей |
| OpenAI | `OPENAI_API_KEY` | Прямий доступ до GPT-4o/5 |
| Google | `GOOGLE_API_KEY` | Моделі Gemini |
| MiniMax | `MINIMAX_API_KEY` | MiniMax M2.5 |
| Anthropic | `ANTHROPIC_API_KEY` | Зазвичай через OAuth в Claude Code |
| OpenCode | `OPENCODE_API_KEY` | Для OpenCode-native маршрутизації |

Можна налаштувати кілька провайдерів одночасно. Платформа автоматично визначає які доступні.

### Опціональні інтеграції

| Змінна | Призначення |
|--------|-------------|
| `TELEGRAM_BOT_TOKEN` | Сповіщення через Telegram бот |
| `OPENCLAW_GATEWAY_TOKEN` | Доступ до OpenClaw API |
| `LLM_MODEL` | Перевизначити модель за замовчуванням (напр. `minimax/minimax-m2.5`) |

## 3. Devcontainer (рекомендовано)

Найшвидший шлях — всі інструменти вже встановлені в образі контейнера.

```bash
make bootstrap
# Відкрити у VS Code → "Reopen in Container"
```

Всередині devcontainer запустіть bootstrap:

```bash
.devcontainer/bootstrap-workspace.sh
```

Це паралельно встановлює:
- OpenCode налаштування та провайдери
- PHP залежності (Composer)
- Node.js залежності (npm/bun)
- E2E тестові залежності (Playwright)
- Міграції бази даних

### Що встановлено в devcontainer

| Категорія | Інструменти |
|-----------|-------------|
| Мови | PHP 8.5, Node.js 22, Go 1.24.1, Python 3 |
| Пакетні менеджери | Composer, npm, Bun |
| AI інструменти | Claude Code, OpenCode |
| Dev інструменти | Docker CLI, kubectl, Helm, k9s, tmux |
| Тестування | Playwright + браузери |

## 4. Перевірка

```bash
# Перевірити сервіси
make status

# Запустити швидку перевірку
make test

# Перевірити підключення LLM провайдерів
opencode providers list
```

## 5. Щоденний workflow

```bash
# Запустити всі сервіси
make up

# Зупинити всі сервіси
make down

# Запустити тести
make test

# Запустити E2E тести
make e2e
```

## 6. Agentic Development (Foundry)

Foundry — це queue-driven пайплайн для виконання задач AI агентами.

### Встановлення монітору (перший раз)

```bash
cd agentic-development/monitor
npm install
npm run build
```

### Запуск Foundry

```bash
# Відкрити інтерактивний TUI монітор
./agentic-development/foundry.sh

# Або запустити headless воркери
./agentic-development/foundry.sh headless

# Перевірити стан
./agentic-development/foundry.sh status
```

### Гарячі клавіші монітору

| Клавіша | Дія |
|---------|-----|
| `↑/↓` | Вибрати задачу |
| `Enter` | Переглянути деталі задачі |
| `a` | Таблиця агентів |
| `l` | Логи агента |
| `s` | Запустити headless воркери |
| `k` | Зупинити воркери |
| `t` | Запустити autotest |
| `T` | Запустити autotest --smoke |
| `1/2` | Перемикання табів (Tasks / Commands) |
| `q` | Вийти |

### Багатопотоковий режим

```bash
# Встановити 3 воркери
FOUNDRY_WORKERS=3 ./agentic-development/foundry.sh headless

# Або регулювати в рантаймі через монітор: ] збільшити, [ зменшити
```

Кожен воркер отримує власний git worktree в `.pipeline-worktrees/worker-N/` та атомарно захоплює задачі з черги.

### Створити задачу

```bash
./agentic-development/foundry.sh task "Виправити CSS сторінки логіну"
```

### Запустити E2E та автоматично створити задачі на виправлення

```bash
./agentic-development/foundry.sh autotest 5 --start
```

## 7. Вирішення проблем

### Контейнер не запускається

```bash
docker compose -f docker/compose.yaml ps
docker compose -f docker/compose.yaml logs
```

### Провайдер не працює

```bash
# Перевірити що ключ встановлено
grep -c 'API_KEY=' .env.local

# Тест OpenRouter
curl -s https://openrouter.ai/api/v1/models -H "Authorization: Bearer $OPENROUTER_API_KEY" | head -1
```

### Монітор не запускається (TypeScript)

```bash
cd agentic-development/monitor
npm install
npm run build
# Fallback: bash версія все ще працює
./agentic-development/lib/pipeline-monitor.sh
```

### Проблеми з git submodules

```bash
git submodule sync
git submodule update --init --recursive
```
