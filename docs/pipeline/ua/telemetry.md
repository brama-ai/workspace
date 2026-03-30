# Телеметрія Pipeline

Foundry відстежує використання токенів, вартість та ефективність кешування для кожного запуску агента. Телеметрія збирається автоматично з events opencode і записується в `tasks/<slug>--foundry/artifacts/telemetry/<agent>.json`.

## Навіщо

Виклики LLM API — основна стаття витрат. Без телеметрії неможливо:

- **Контролювати кости** — знати реальну вартість кожного run по провайдерах (Anthropic, OpenAI, Google, MiniMax, Moonshot тощо).
- **Бачити скидання кешу** — моделі GLM та Kimi скидають кеш біля 100K токенів. Без потокового трекінгу ці скидання невидимі і непомітно збільшують вартість.
- **Порівнювати ефективність моделей** — деякі моделі витрачають у 5 разів більше токенів на ту саму задачу.
- **Виявляти зациклених агентів** — агент у циклі показує аномальну кількість повідомлень і output токенів.

## Що збирається

Для кожного агента Foundry витягує з opencode events JSONL:

| Поле | Джерело | Опис |
|------|---------|------|
| `input` | `step_finish.tokens.input` | Свіжі input токени (не з кешу) |
| `output` | `step_finish.tokens.output` | Згенеровані output токени |
| `cacheRead` | `step_finish.tokens.cache.read` | Токени з кешу (дешевші або безкоштовні) |
| `cacheWrite` | `step_finish.tokens.cache.write` | Токени записані в кеш |
| `messageCount` | кількість `step_start` | Кількість LLM round-trips |
| `toolCalls` | `tool_use.tool` | Унікальні інструменти (Read, Edit, Bash тощо) |
| `filesRead` | `tool_use.state.input.file_path` | Файли прочитані під час run |
| `cost` | Розраховується за pricing моделі | Орієнтовна вартість у USD |

## Секції summary

Summarizer (`u-summarizer`) рендерить дві секції телеметрії:

### Таблиця агентів

Один рядок на агента: модель, повідомлення, input/output/cache токени, вартість, тривалість.

```
| Agent | Model | Msgs | Input | Output | Cache Read | Price | Time |
```

### Token Burn

Прогресивні snapshot'и по кожному агенту, записуються кожні ~20K росту контексту. Кожен рядок показує **per-step** значення (що саме на цьому кроці) та **cumulative** (наростаючий підсумок).

```
| Agent | Context | Msgs | Input | Output | Cache | Cum In | Cum Out | Tools | Files | Cum Price |
```

**Семантика колонок:**

| Колонка | Тип | Значення |
|---------|-----|----------|
| Context | per-step | Розмір вікна контексту = Input + Cache (що бачить модель) |
| Input | per-step | Свіжі токени не з кешу (білляться за повну ціну input) |
| Output | per-step | Токени згенеровані на цьому кроці |
| Cache | per-step | Токени подані з кешу (дешевше або безкоштовно) |
| Cum In | cumulative | Сума Input по всіх rendered рядках агента |
| Cum Out | cumulative | Сума Output по всіх rendered рядках |
| Msgs | cumulative | Загальна кількість повідомлень |
| Tools | cumulative | Загальна кількість tool calls |
| Files | cumulative | Загальна кількість прочитаних файлів |
| Cum Price | cumulative | Наростаюча вартість |

**На що звертати увагу:**

- **Context росте рівномірно** — нормальна поведінка, кеш працює.
- **Cache падає до 0 посеред run** — виявлено скидання кешу (GLM/Kimi біля 100K). Input стрибне на наступному рядку.
- **Input >> 1 на кожному кроці** — погане кешування (Claude має вищий Input бо tool outputs не кешуються).
- **Стрибок Output** — агент згенерував великий блок коду або файл на цьому кроці.

## Виявлення скидання кешу

Деякі провайдери (GLM через ZhipuAI, Kimi через Moonshot) скидають кеш коли контекст наближається до ~100K токенів. При цьому:

1. `cache_read` падає до 0 для наступних кроків
2. `input` стрибає бо повний контекст пересилається заново
3. Вартість кроку різко зростає

Таблиця Token Burn це показує: якщо модель має низький cache hit % попри багато повідомлень — ймовірно стався cache reset. Рішення — увімкнути auto-compaction (`context-guard`) до досягнення ліміту.

## Розрахунок вартості

Вартість оцінюється за опублікованими цінами за 1M токенів:

| Провайдер | Білінг | Приклад моделі | Input $/M | Output $/M | Cache Read $/M |
|-----------|--------|----------------|----------:|-----------:|---------------:|
| Anthropic | subscription | claude-sonnet-4-6 | $3 | $15 | $0.30 |
| OpenAI | subscription | gpt-5.4 | $5 | $15 | — |
| Google | free | gemini-2.5-flash | $0.075 | $0.30 | — |
| MiniMax | subscription | MiniMax-M2.7 | $0.30 | $1.20 | — |
| Moonshot | pay-as-you-go | kimi-k2.5 | $0.50 | $2.00 | — |

Для subscription-провайдерів (Anthropic Max, OpenAI Pro) фактична вартість $0, але estimated cost трекається для порівняння ефективності між моделями.

## Формат файлу

Кожен `artifacts/telemetry/<agent>.json`:

```json
{
  "agent": "u-coder",
  "model": "MiniMax-M2.7",
  "tokens": {
    "input_tokens": 350,
    "output_tokens": 27870,
    "cache_read": 4674973,
    "cache_write": 140814
  },
  "tools": ["Read", "Edit", "Bash", "Grep", "Glob"],
  "files_read": ["/src/Controller/AgentController.php"],
  "context": {
    "message_count": 48
  },
  "cost": 0.033459,
  "duration_seconds": 689,
  "session_id": ""
}
```

## Архітектура

```
opencode (процес агента)
  │
  ├── stdout JSON events ──► events JSONL файл
  │     step_start, tool_use, step_finish (з токенами)
  │
  └── exit code ──► executor.ts
                      │
                      ├── extractTelemetryFromEvents()
                      │     Парсить events JSONL, сумує токени,
                      │     збирає tools/files, рахує вартість
                      │
                      └── AgentResult { tokensUsed, messageCount, toolCalls, filesRead }
                            │
                            ▼
                      runner.ts
                        │
                        └── пише artifacts/telemetry/<agent>.json
                              │
                              ▼
                        render-summary.ts (u-summarizer)
                          │
                          └── читає всі JSON файли → markdown таблиці
```
