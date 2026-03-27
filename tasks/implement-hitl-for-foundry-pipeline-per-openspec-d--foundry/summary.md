# Implement HITL for Foundry Pipeline per OpenSpec

**Статус:** PASS
**Workflow:** Foundry
**Профіль:** standard
**Тривалість:** ~10m (u-planner 1m51s + u-coder 7m49s + u-validator 4s)
**Гілка:** `pipeline/implement-hitl-for-foundry-pipeline-per-openspec-d`
**Pipeline ID:** 20260326_200210

## Що зроблено

- Додано HITL-протокол (Human-in-the-Loop) до 7 агентів, які його не мали: `u-deployer`, `u-doctor`, `u-ops-agent`, `u-planner`, `u-reviewer`, `u-security-review`, `u-translater`
- Доповнено HITL-протокол для `u-summarizer` (мав часткову згадку qa.json, але без повної секції)
- Створено UA-переклад документації HITL: `docs/pipeline/ua/human-in-the-loop.md`
- Змінено 10 файлів, додано ~350 рядків
- Коміти: `086940d` (u-coder), `e01c250` (u-validator)

## Telemetry

| Agent | Model | Input | Output | Price | Time |
|-------|-------|------:|-------:|------:|-----:|
| u-planner | anthropic/claude-opus-4-6 | 17 | 3,905 | $1.53 | 1m 51s |
| u-coder | zai-coding-plan/glm-5 | 644,809 | 53,705 | $0.00 | 7m 49s |
| u-validator | opencode-go/kimi-k2.5 | 0 | 0 | $0.00 | 4s |
| **Разом** | | **644,826** | **57,610** | **$1.53** | **9m 44s** |

> Примітка: попередній запуск u-summarizer (openai/gpt-5.4) завершився з exit_code=2, витративши 794K input tokens / $7.04 за 15хв. Ці витрати не включені в підсумок поточного пайплайну, але враховані нижче в рекомендаціях.

## Моделі

| Model | Agents | Input | Output | Price |
|-------|--------|------:|-------:|------:|
| anthropic/claude-opus-4-6 | u-planner | 17 | 3,905 | $1.53 |
| zai-coding-plan/glm-5 | u-coder | 644,809 | 53,705 | $0.00 |
| opencode-go/kimi-k2.5 | u-validator | 0 | 0 | $0.00 |

## Tools By Agent

### u-planner
- `glob` x 15
- `read` x 10
- `grep` x 6
- `bash` x 4
- `skill` x 1
- `write` x 1

### u-coder
- `bash` x 62
- `read` x 52
- `edit` x 35
- `todowrite` x 9
- `write` x 7
- `glob` x 3
- `grep` x 2

### u-validator
- none recorded

## Files Read By Agent

### u-planner
- `.opencode/agents/CONTEXT-CONTRACT.md`
- `docs/pipeline/en/openspec-human-in-the-loop.md`
- `docs/pipeline/en/human-in-the-loop.md`
- `agentic-development/lib/foundry-run.sh`
- `agentic-development/lib/foundry-common.sh`
- `agentic-development/lib/foundry-telegram.sh`
- `agentic-development/telegram-qa/src/bot.ts`
- `agentic-development/foundry.sh`

### u-coder
- `.opencode/agents/*` (8 agent definition files)
- `agentic-development/lib/foundry-run.sh`
- `agentic-development/lib/foundry-common.sh`
- `agentic-development/monitor/src/components/App.tsx`
- `agentic-development/monitor/src/lib/tasks.ts`
- `docs/pipeline/en/human-in-the-loop.md`
- та інші (52 read-операції загалом)

### u-validator
- none recorded

## Самооцінка агентів

### u-coder (confidence: 0.92)
**Що вдалось:**
- Більшість HITL-інфраструктури вже була реалізована (foundry-common.sh, foundry-run.sh, telegram-qa бот, monitor QA view)
- Основні агенти (u-architect, u-coder, u-auditor, u-validator, u-tester, u-documenter, u-investigator, u-merger) вже мали HITL-протокол
- Успішно додано протокол до всіх решти агентів + UA-переклад документації

**Відхилення від специфікації:**
- Специфікація згадує `monitor/src/components/QAView.tsx` як окремий файл, але QAView вбудований в `App.tsx` — функціонально еквівалентно
- Agent-to-agent Q&A escalation (Section 14) задокументований у специфікації, але `foundry-run.sh` не включає виклик u-architect Q&A responder mode — це існуючий gap, не введений цією задачею

## Труднощі

- Не було надано `tasks.md` з чеклістом — scope визначався безпосередньо з OpenSpec документа
- Специфікація описує функціональність (Section 13: Wait Timeout Strategy, Section 14: Agent-to-Agent Q&A), яка виходить за межі цієї задачі — потребує окремих задач

## Незавершене

- **u-tester не запускався** — був у `planned_agents`, але не виконаний. Тести для HITL-протоколу не написані
- Agent-to-agent Q&A escalation (Section 14 специфікації) — не реалізовано в оркестраторі
- Wait Timeout Strategy (Section 13 специфікації) — логіка timeout enforcement не реалізована
- Виділення QAView в окремий компонент (`monitor/src/components/QAView.tsx`)

## Рекомендації по оптимізації

### 🟡 Token anomaly: u-coder використав 644K input tokens

**Що сталось:** u-coder прочитав 52 файли та виконав 62 bash-команди, накопичивши 644,809 input tokens — перевищення порогу 500K.
**Вплив:** Збільшений час виконання (7m49s), хоча вартість $0.00 завдяки безкоштовній моделі zai-coding-plan/glm-5.
**Рекомендація:**
- Варіант A: Надавати більш точний scope через `tasks.md` з чеклістом файлів, щоб агент не сканував всю кодову базу
- Варіант B: Використовувати `context_files` в делегації, щоб обмежити область пошуку

### 🟡 Empty output: u-validator записав 0 tokens / 0 файлів

**Що сталось:** u-validator завершився за 4 секунди з 0 input/output tokens і без жодного tool call. Модель opencode-go/kimi-k2.5 не виконала жодної перевірки.
**Вплив:** Валідація фактично не відбулась — змінені `.md` файли не перевірені на коректність.
**Рекомендація:**
- Варіант A: Перевірити, чи opencode-go/kimi-k2.5 коректно обробляє задачі валідації markdown-файлів
- Варіант B: Для задач без PHP-коду (тільки markdown/agent definitions) — пропускати u-validator або використовувати спрощену перевірку

### 🔴 Попередній u-summarizer: exit_code=2, $7.04, 15хв, 794K tokens

**Що сталось:** Попередній запуск u-summarizer на моделі openai/gpt-5.4 завершився з помилкою (exit_code=2), витративши 794,291 input tokens, 67,862 output tokens, $7.04 за 15 хвилин. Телеметрія показує ідентичний session_id та files_read як у u-coder — можливо, дані були некоректно скопійовані.
**Вплив:** $7.04 витрачено без результату. Загальні витрати пайплайну з урахуванням цього фейлу: $8.57 (перевищення порогу $2.00).
**Рекомендація:**
- Варіант A: Дослідити причину exit_code=2 у попередньому запуску summarizer — можливо, модель не змогла обробити формат задачі
- Варіант B: Використовувати anthropic/claude-opus-4-6 або anthropic/claude-sonnet-4-6 для summarizer замість openai/gpt-5.4

### 🟡 u-tester пропущений: запланований, але не виконаний

**Що сталось:** `pipeline-plan.json` включає `u-tester` в `planned_agents`, але в `checkpoint.json` та `state.json` агент відсутній.
**Вплив:** Тести для нових HITL-секцій в agent definitions не написані та не запущені.
**Рекомендація:**
- Варіант A: Додати u-tester до наступного запуску для перевірки HITL-протоколу
- Варіант B: Для задач, що змінюють тільки markdown/agent definitions, явно вказувати в плані чи потрібен tester

## Рекомендовані задачі

- **Agent-to-Agent Q&A Escalation** — реалізувати u-architect Q&A responder mode в `foundry-run.sh` (Section 14 специфікації). Коли агент виходить з кодом 75, оркестратор має спробувати вирішити питання через u-architect перед ескалацією до людини. Файли: `agentic-development/lib/foundry-run.sh`, `agentic-development/lib/foundry-common.sh`
- **Wait Timeout Strategy** — реалізувати timeout enforcement для стану `waiting_answer` (Section 13 специфікації). Наразі існують тільки Telegram notification функції, але логіка перевірки timeout та `on_timeout` дій не реалізована. Файли: `agentic-development/lib/foundry-common.sh`, `agentic-development/lib/foundry-run.sh`
- **QAView як окремий компонент** — виділити QAView з `App.tsx` в `monitor/src/components/QAView.tsx` для кращої організації коду (Section 6 специфікації)

## Наступна задача

**Agent-to-Agent Q&A Escalation в foundry-run.sh**

Чому зараз: це ключова частина HITL-специфікації (Section 14), яка дозволить агентам автоматично вирішувати питання через u-architect перед ескалацією до людини. Це зменшить кількість блокуючих пауз пайплайну та прискорить виконання задач.

Очікуваний результат: коли агент виходить з exit_code=75, оркестратор запускає u-architect в Q&A mode для спроби відповісти на питання. Якщо u-architect не може відповісти — ескалація до людини через Telegram.

---

## Вартість пайплайну

| Агент | Тривалість | Input | Output | Cache Read | Cache Write | ≈ Вартість |
|-------|-----------|-------|--------|------------|-------------|-----------|
| u-coder | 7m 53s | 644809 | 53705 | 18027616 | 0 | $8.148 |
| u-validator | 7s | 0 | 0 | 0 | 0 | $0.000 |
| u-summarizer | 17m 38s | 13 | 7281 | 340181 | 45769 | $0.383 |
| **Всього** | **25m** | **644822** | **60986** | **18367797** | **45769** | **$8.531** |

_Вартість розрахована приблизно за тарифами Claude Sonnet ($3/$15 per 1M in/out, $0.30/$3.75 cache r/w)._
