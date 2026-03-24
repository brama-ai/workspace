# Task Summary: Restore full TUI monitor for Foundry

## Загальний статус
- Статус пайплайну: PASS, **PIPELINE COMPLETE**
- Гілка: `pipeline/restore-full-tui-monitor-for-foundry`
- Pipeline ID: `20260324_125631`
- Workflow: `Foundry`
- Профіль: `standard`
- Тривалість: приблизно 16м 31с до завершення tester; підсумок зібрано окремо

## Telemetry
**Workflow:** Foundry

## Telemetry

| Agent | Model | Input | Output | Price | Time |
|-------|-------|------:|-------:|------:|-----:|
| coder | anthropic/claude-sonnet-4-6 | 17 | 16686 | $0.5795 | 4m 17s |
| planner | anthropic/claude-opus-4-6 | 15 | 3768 | $0.9055 | 1m 44s |
| tester | openai/gpt-5.3-codex | 30230 | 2507 | $0.0944 | 1m 36s |
| validator | openai/gpt-5.4 | 18374 | 822 | $0.0557 | 39s |

## Моделі

| Model | Agents | Input | Output | Price |
|-------|--------|------:|-------:|------:|
| anthropic/claude-opus-4-6 | planner | 15 | 3768 | $0.9055 |
| anthropic/claude-sonnet-4-6 | coder | 17 | 16686 | $0.5795 |
| openai/gpt-5.3-codex | tester | 30230 | 2507 | $0.0944 |
| openai/gpt-5.4 | validator | 18374 | 822 | $0.0557 |

## Tools By Agent

### coder
- `bash` x 6
- `edit` x 2
- `read` x 6
- `skill` x 1
- `todowrite` x 3
- `write` x 1

### planner
- `bash` x 2
- `glob` x 22
- `grep` x 2
- `read` x 8
- `skill` x 1
- `write` x 2

### tester
- `apply_patch` x 1
- `bash` x 8
- `glob` x 3
- `read` x 3
- `skill` x 1

### validator
- `apply_patch` x 1
- `read` x 1
- `skill` x 1
- `todowrite` x 2

## Files Read By Agent

### coder
- `.opencode/pipeline/handoff.md`
- `agentic-development/foundry.sh`
- `agentic-development/lib/foundry-common.sh`
- `agentic-development/lib/foundry-monitor.sh`
- `agentic-development/lib/pipeline-monitor.sh`
- `brama-core/.pipeline-worktrees/worker-1/builder/monitor/pipeline-monitor.sh`

### planner
- `.opencode/agents/CONTEXT-CONTRACT.md`
- `agentic-development/foundry.sh`
- `agentic-development/lib/foundry-common.sh`
- `agentic-development/lib/foundry-monitor.sh`
- `pipeline-plan.json`

### tester
- `.opencode/pipeline/handoff.md`

### validator
- `.opencode/pipeline/handoff.md`

## Агенти
### planner
- Що зробив: визначив профіль `standard`, маршрут `coder -> validator -> tester -> summarizer`, пропустив OpenSpec як зайвий для цього добре специфікованого shell/TUI-завдання.
- Які були складнощі або блокери: референсні OpenSpec-файли та частина очікуваних шляхів не знайшлись; також був одноразовий збій запису `pipeline-plan.json`, який агент виправив після читання файлу. Підсумково блокерів не залишилось.
- Що залишилось виправити або доробити: нічого критичного; план уже покривав потрібний pipeline path.

### coder
- Що зробив: відновив повноцінний TUI-монітор у `agentic-development/lib/pipeline-monitor.sh` та переключив `agentic-development/foundry.sh` на новий entrypoint.
- Які були складнощі або блокери: треба було адаптувати старий monitor до Foundry state/task model, `events.jsonl` і serial runtime без worktree workers; блокуючих помилок у логах немає.
- Що залишилось виправити або доробити: бажано окремо вручну перевірити інтерактивні сценарії в живому TTY, які не покриваються shell smoke tests.

### validator
- Що зробив: перевірив scope змін і підтвердив, що жоден з PHP app-targets валідатора не змінювався; оновив handoff.
- Які були складнощі або блокери: блокерів не було; app-level `cs-check`/`analyse` не застосовувались до `agentic-development/`.
- Що залишилось виправити або доробити: за потреби можна додати окремий bash-oriented validator для runtime shell tooling.

### tester
- Що зробив: прогнав `agentic-development/tests/test-ultraworks-monitor.sh`, `agentic-development/tests/test-pipeline-lifecycle.sh`, `agentic-development/tests/test-env-check.sh`, а також `bash -n` для змінених shell-файлів; усі прогони успішні, включно з фінальним re-run.
- Які були складнощі або блокери: блокерів не було; у логах лише expected unit-mode skips, без падінь або таймаутів.
- Що залишилось виправити або доробити: немає автотесту саме на live keyboard navigation/auto-refresh нового Foundry TUI.

## Труднощі
- Референси з handoff були частково застарілі: planner не знайшов очікувані OpenSpec- та monitor-paths, але задача мала достатньо опису для виконання.
- Основна складність була в перенесенні старого великого TUI на нову модель Foundry без worktree workers і з JSONL activity log.
- У planner був одноразовий tool-usage збій під час запису `pipeline-plan.json`; після повтору робота пішла штатно.

## Незавершене
- Ручний інтерактивний smoke-test у реальному TTY для клавіш `s`, `k`, `q`, навігації стрілками та автооновлення кожні 3 секунди все ще варто виконати окремо.

## Що треба доробити
- Провести ручну перевірку `./agentic-development/foundry.sh` у справжньому терміналі з кількома `tasks/*--foundry/`, щоб підтвердити live-навігацію, Activity tab та clean terminal restore після виходу.

## Рекомендації по оптимізації
### 🟡 Токен аномалія: `coder` перевищив 500K токенів через великий кешований контекст
**Що сталось:** за telemetry `coder` використав понад 1.19M токенів з урахуванням `cache_read` і `cache_write`, бо працював з великим shell-файлом, старим референсним TUI та повторними читаннями контексту.
**Вплив:** пайплайн завершився успішно, але вартість і контекстне навантаження на основного виконавця були вищими, ніж потрібно для зміни двох файлів.
**Рекомендація:** зменшити обсяг вхідного контексту для великих TUI/bash-рефакторингів і передавати кодеру точні вирізки замість широкого handoff/read set.
- Варіант A: у planner передавати coder лише референсний файл, список обов'язкових адаптацій і конкретні helper-функції з `foundry-common.sh`.
- Варіант B: ділити подібні задачі на два кроки - спочатку scaffold/entrypoint, потім окремий pass на activity/detail behavior.

## Пропозиція до наступної задачі
- Назва задачі: Додати інтерактивний smoke/E2E тест для Foundry TUI monitor
- Чому її варто створити зараз: реалізація вже готова і пройшла shell-регресію, але live TTY-поведінка нового monitor ще не зафіксована автоматизовано.
- Очікуваний результат: з'явиться відтворюваний тест або harness, який перевіряє запуск TUI, базову навігацію, Activity tab, автооновлення та коректне відновлення термінала після виходу.
