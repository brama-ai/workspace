# Implement Wait Timeout Strategy

**Статус:** FAIL
**Workflow:** Foundry
**Профіль:** standard
**Гілка:** `pipeline/implement-wait-timeout-strategy-section-13-of-docs`
**Pipeline ID:** `20260327_103444`
**Тривалість:** ~12m (planner 1m27s + coder 5m08s + validator 11s + summarizer 5m18s)
**Коміт:** `279c238`

## Що зроблено

- Реалізовано стратегію Wait Timeout для HITL-пайплайну з трьома режимами: `fail` (за замовчуванням, 4h), `skip`, `fallback`
- Додано 9 нових функцій у `agentic-development/lib/foundry-common.sh`: `foundry_handle_waiting_answer()`, `foundry_qa_check_timeout()`, `foundry_qa_timeout_monitor()`, `foundry_qa_apply_timeout_strategy()`, `foundry_qa_timeout_seconds()`, `foundry_qa_on_timeout()`, `foundry_qa_reminder_at()`, `_foundry_parse_duration_seconds()`, `_foundry_format_duration()`
- Оновлено `agentic-development/lib/foundry-run.sh` — обробка `continue_on_wait=true` при exit code 75
- Telegram-нагадування на порогах 50% і 90% від timeout
- Конфігурація через `qa_timeout`, `qa_on_timeout`, `qa_reminder_at` у `pipeline-plan.json`
- Per-question override через `on_timeout` і `default_answer` у `qa.json` (з обмеженням — див. Труднощі)
- Файли змінено: 2 (`foundry-common.sh`, `foundry-run.sh`)

## Telemetry

| Agent | Model | Input | Output | Price | Time |
|-------|-------|------:|-------:|------:|-----:|
| u-planner | anthropic/claude-opus-4-6 | 12 | 2750 | $1.3133 | 1m 27s |
| u-coder | anthropic/claude-sonnet-4-6 | 34 | 13713 | $1.2400 | 5m 08s |
| u-validator | opencode-go/kimi-k2.5 | 0 | 0 | $0.0000 | 11s |
| u-summarizer | openai/gpt-5.4 | 132909 | 6344 | $0.3680 | 5m 18s |
| **Разом** | | **132955** | **22807** | **$2.9213** | **~12m** |

## Моделі

| Model | Agents | Input | Output | Price |
|-------|--------|------:|-------:|------:|
| anthropic/claude-opus-4-6 | u-planner | 12 | 2750 | $1.3133 |
| anthropic/claude-sonnet-4-6 | u-coder | 34 | 13713 | $1.2400 |
| openai/gpt-5.4 | u-summarizer | 132909 | 6344 | $0.3680 |
| opencode-go/kimi-k2.5 | u-validator | 0 | 0 | $0.0000 |

## Tools By Agent

### u-planner
- `glob` x 4
- `grep` x 3
- `read` x 8
- `skill` x 1
- `write` x 2

### u-coder
- `bash` x 10
- `edit` x 5
- `glob` x 3
- `grep` x 1
- `read` x 12
- `skill` x 1
- `todowrite` x 4
- `write` x 1

### u-validator
- none recorded (не встиг стартувати)

### u-summarizer (попередня спроба)
- `apply_patch` x 1
- `bash` x 1
- `glob` x 9
- `grep` x 1
- `read` x 19
- `skill` x 1

## Files Read By Agent

### u-planner
- `.opencode/agents/CONTEXT-CONTRACT.md`
- `agentic-development/lib/foundry-common.sh`
- `agentic-development/lib/foundry-run.sh`
- `agentic-development/lib/foundry-telegram.sh`
- `docs/pipeline/en/openspec-human-in-the-loop.md`
- `pipeline-plan.json`

### u-coder
- `agentic-development/lib/foundry-common.sh`
- `agentic-development/lib/foundry-run.sh`
- `agentic-development/lib/foundry-telegram.sh`
- `docs/pipeline/en/openspec-human-in-the-loop.md`
- `.opencode/pipeline/handoff.md`

### u-validator
- none recorded

## Агенти

### u-planner
- **Що зробив:** визначив профіль `standard`, підготував `pipeline-plan.json` з агентами `[u-coder, u-validator, u-tester, u-summarizer]`, підтвердив що зміни локалізовані у двох shell-файлах
- **Складнощі:** явних блокерів не зафіксовано
- **Залишилось:** нічого в межах планування

### u-coder
- **Що зробив:** реалізував повну стратегію Wait Timeout — 9 функцій у `foundry-common.sh`, інтеграцію з `foundry-run.sh`, Telegram-нагадування, три стратегії timeout; коміт `279c238`
- **Складнощі:** per-question `timeout` duration override не відслідковується окремо у фоновому моніторі — монітор використовує task-level timeout. Поля `on_timeout` і `default_answer` per-question працюють коректно
- **Залишилось:** перевірити per-question timeout override у реальному прогоні; можливо доробити окремий трекінг тривалості на рівні питання

### u-validator
- **Що зробив:** фактично не виконав жодної перевірки — сесія завершилась одразу після старту
- **Складнощі:** 🔴 блокер — API провайдера `opencode-go/kimi-k2.5` повернув `Insufficient balance`, агент не зміг навіть прочитати контекст
- **Залишилось:** повторно прогнати валідацію після відновлення білінгу або з іншим провайдером

### u-tester (не запускався)
- **Що зробив:** не був запущений через зрив ланцюжка на етапі validator
- **Залишилось:** написати та прогнати тести для нових функцій timeout

## Труднощі

- `u-validator` не зміг стартувати через `Insufficient balance` на провайдері `opencode-go/kimi-k2.5` — це зупинило весь quality gate
- `u-tester` не запускався взагалі, бо залежить від успішної валідації
- Попередня спроба `u-summarizer` (openai/gpt-5.4) завершилась з exit code 2 — потребувала повторного запуску

## Незавершене

- ❌ Валідація (`u-validator`) — не виконана
- ❌ Тестування (`u-tester`) — не запущене
- ⚠️ Per-question timeout duration override — працює частково (on_timeout/default_answer — так, індивідуальний трекінг тривалості — ні)
- ⚠️ Практична перевірка сценаріїв `skip`, `fallback` та Telegram reminders у реальному прогоні

## Рекомендації по оптимізації

### 🔴 Pipeline FAIL: ланцюжок зупинився на `u-validator`
**Що сталось:** `u-validator` завершився без валідації через помилку провайдера `Insufficient balance` (opencode-go/kimi-k2.5). Далі `u-tester` не запускався.
**Вплив:** немає підтвердження що зміни проходять перевірки та тести; пайплайн залишився незавершеним. Код закомічений, але не верифікований.
**Рекомендація:**
- Варіант A: додати preflight-перевірку доступності моделі/кредитів перед запуском validator/tester
- Варіант B: налаштувати автоматичний fallback на альтернативного провайдера (наприклад, anthropic/claude-sonnet-4-6) при `Insufficient balance`

### 🟡 Вартість пайплайну: $2.92 (перевищує поріг $2.00)
**Що сталось:** `u-planner` використав ~738K cache-read токенів ($1.31), `u-coder` ~3.45M cache-read ($1.24) для задачі з двома shell-файлами. Додатково $0.37 на summarizer.
**Вплив:** підвищена собівартість для відносно локальної зміни.
**Рекомендація:**
- Варіант A: звузити делегаційний prompt до конкретних ділянок файлів, передавати точні офсети замість повного контексту
- Варіант B: для shell-only задач використовувати дешевшу модель для планування (sonnet замість opus)

### 🟡 Summarizer stall: попередня спроба завершилась з exit code 2
**Що сталось:** перша спроба `u-summarizer` (openai/gpt-5.4, 5m18s) не згенерувала фінальний звіт автоматично — потребувала повторного запуску.
**Вплив:** затримка у генерації звіту, додаткові витрати на повторний запуск.
**Рекомендація:**
- Додати heartbeat/progress logging на старті summarizer
- Налаштувати timeout-recovery з автоматичним перезапуском без ручного втручання

## Наступна задача

- **Назва:** Відновити quality gate для Wait Timeout Strategy
- **Чому зараз:** реалізація вже закомічена (`279c238`), але пайплайн не підтвердив її через зірвану валідацію і відсутній тестовий прохід. Код не верифікований.
- **Очікуваний результат:** `u-validator` і `u-tester` успішно завершені; зміни до `agentic-development/lib/foundry-common.sh` та `agentic-development/lib/foundry-run.sh` підтверджені перевірками та тестами

---

## Вартість пайплайну

| Агент | Тривалість | Input | Output | Cache Read | Cache Write | ≈ Вартість |
|-------|-----------|-------|--------|------------|-------------|-----------|
| u-summarizer | 9m 53s | 24 | 9605 | 979097 | 58380 | $0.657 |
| **Всього** | **9m** | **24** | **9605** | **979097** | **58380** | **$0.657** |

_Вартість розрахована приблизно за тарифами Claude Sonnet ($3/$15 per 1M in/out, $0.30/$3.75 cache r/w)._
