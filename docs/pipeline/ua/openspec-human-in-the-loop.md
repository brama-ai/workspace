# OpenSpec: Human-in-the-Loop (HITL) для Foundry Pipeline

**Статус**: Чернетка / Брейнсторм
**Автор**: Pipeline team
**Дата**: 2026-03-26
**Область**: Foundry оркестратор, TUI монітор, протокол агентів, формат handoff

---

## 1. Проблема

Зараз, коли агент Foundry стикається з неоднозначністю або потребує уточнення від людини, він має два варіанти: впасти або вгадати. Обидва — погані:

- **Впасти** — витрачає весь запуск агента та потребує ручного перезапуску
- **Вгадати** — може дати некоректний результат, який пропагується через пайплайн

Потрібен структурований механізм **human-in-the-loop**, який дозволяє агентам:
1. Поставити на паузу з конкретними питаннями
2. Передати естафету наступному агенту, поки чекаємо відповіді
3. Відновити роботу з того місця, де зупинились, коли відповіді отримані

---

## 2. Новий стан задачі: `waiting_answer`

### 2.1 Розширення State Machine

```
pending → in_progress → completed
                ↓              ↑
          waiting_answer ──────┘  (resume після відповідей)
                ↓
          in_progress  (наступний агент продовжує паралельно)
                ↓
            failed / completed
```

### 2.2 Семантика стану

| Стан | Значення |
|------|----------|
| `waiting_answer` | Агент має невідповідні питання; пайплайн може продовжити з наступними агентами або чекати |

### 2.3 Стан в `state.json`

```json
{
  "status": "waiting_answer",
  "waiting_agent": "u-architect",
  "waiting_since": "2026-03-26T14:30:00Z",
  "questions_count": 2,
  "questions_answered": 0,
  "resume_from": "u-architect"
}
```

### 2.4 Правила поведінки

- Коли агент виставляє `waiting_answer`, оркестратор перевіряє, чи наступний агент **може працювати без відповідей** (конфігурується в профілі).
- **Поведінка за замовчуванням**: пауза пайплайну, чекаємо відповідь, потім resume з `waiting_agent`.
- **Опціональна поведінка** (`continue_on_wait: true` в профілі): перескочити до наступного агента, повернутися до очікуючого пізніше.
- Задачі в `waiting_answer` відображаються в окремій секції TUI монітора.

---

## 3. Протокол Q&A

### 3.1 Зберігання Q&A: `qa.json`

Замість вбудовування Q&A в handoff.md (markdown важче парсити), використовуємо структурований JSON файл поряд з handoff.

**Розташування**: `tasks/<slug>--foundry/qa.json`

```json
{
  "version": 1,
  "questions": [
    {
      "id": "q-001",
      "agent": "u-architect",
      "timestamp": "2026-03-26T14:30:00Z",
      "priority": "blocking",
      "category": "clarification",
      "question": "Задача згадує 'оновити auth flow', але в проєкті є дві auth системи: edge-auth (Traefik middleware) та internal JWT auth (brama-core). Яку потрібно змінити?",
      "context": "Знайдено в docker/traefik/dynamic.yml та brama-core/src/Security/",
      "options": [
        "edge-auth (Traefik middleware)",
        "internal JWT auth (brama-core)",
        "обидві"
      ],
      "answer": null,
      "answered_at": null,
      "answered_by": null
    },
    {
      "id": "q-002",
      "agent": "u-architect",
      "timestamp": "2026-03-26T14:30:05Z",
      "priority": "non-blocking",
      "category": "preference",
      "question": "Новий endpoint має слідувати REST конвенції (/api/v1/resources) чи відповідати існуючому паттерну (/api/resources)?",
      "context": "Існуючі маршрути в brama-core/config/routes/api.yaml",
      "options": [
        "/api/v1/resources (REST стандарт)",
        "/api/resources (відповідає існуючим)"
      ],
      "answer": null,
      "answered_at": null,
      "answered_by": null
    }
  ]
}
```

### 3.2 Поля питання

| Поле | Тип | Обов'язкове | Опис |
|------|-----|-------------|------|
| `id` | string | так | Унікальний ID, авто-генерований (`q-NNN`) |
| `agent` | string | так | Агент, який поставив питання |
| `timestamp` | ISO8601 | так | Коли питання було створено |
| `priority` | enum | так | `blocking` (пайплайн чекає) або `non-blocking` (пайплайн продовжує) |
| `category` | enum | так | `clarification`, `preference`, `approval`, `technical` |
| `question` | string | так | Текст питання |
| `context` | string | ні | Додатковий контекст (файли, посилання на код) |
| `options` | string[] | ні | Запропоновані варіанти відповіді |
| `answer` | string | null | Відповідь людини (null поки не відповіли) |
| `answered_at` | ISO8601 | null | Коли відповіли |
| `answered_by` | string | null | Хто відповів |

### 3.3 Пріоритет питань

- **`blocking`**: Пайплайн зупиняється на цьому агенті. Не може продовжити без відповіді. Використовується коли агент буквально не може працювати далі.
- **`non-blocking`**: Пайплайн продовжує з наступними агентами. Очікуючий агент буде перезапущений після отримання відповідей. Для переваг або оптимізацій.

### 3.4 Інтеграція з Handoff.md

Коли агент записує питання в `qa.json`, форматоване резюме також додається в `handoff.md`:

```markdown
## Architect

- **Status**: waiting_answer
- **Questions**: 2 (0 answered)

### Q&A

> **Q1** [blocking] Яку auth систему потрібно змінити?
> - [ ] edge-auth (Traefik middleware)
> - [ ] internal JWT auth (brama-core)
> - [ ] обидві
>
> **A1**: —

> **Q2** [non-blocking] REST конвенція іменування?
> - [ ] /api/v1/resources (REST стандарт)
> - [ ] /api/resources (відповідає існуючим)
>
> **A2**: —
```

---

## 4. Протокол агентів для HITL

### 4.1 Коли ставити питання

Агенти ПОВИННІ ставити питання коли:
- Опис задачі неоднозначний і існує кілька валідних інтерпретацій
- Рішення впливає на архітектуру або безпеку і агент не впевнений
- Задача потребує вибору між несумісними підходами
- Потрібна зовнішня інформація, яку агент не може знайти в кодовій базі

Агенти НЕ ПОВИННІ ставити питання коли:
- Відповідь чітко виводиться з кодової бази, handoff або опису задачі
- Це стилістична перевага без значного впливу
- Агент є призначеним decision-maker для цієї області

### 4.2 Як ставити питання (сторона агента)

Агенти записують питання створюючи/доповнюючи `qa.json` в директорії задачі.

Агент ПОВИНЕН:
1. Записати питання в `qa.json`
2. Оновити свою секцію в `handoff.md` зі статусом `waiting_answer` та Q&A резюме
3. Завершити зі **спеціальним exit code** (`exit 75` — EX_TEMPFAIL з sysexits.h)

### 4.3 Конвенція Exit Code

| Exit Code | Значення |
|-----------|----------|
| 0 | Успіх — агент завершив нормально |
| 75 | Очікування відповіді — агент має питання в qa.json |
| 124 | Таймаут |
| 1-74, 76-123 | Помилка |

### 4.4 Як відновити роботу (сторона агента)

При resume після відповідей:
1. Прочитати `qa.json` — всі відповіді заповнені
2. Прочитати `handoff.md` — попередній прогрес збережено
3. Продовжити роботу з урахуванням відповідей
4. По завершенню оновити статус в handoff.md на `done`

Оркестратор передає прапорець для resume mode:

```
CONTEXT += "Ви ВІДНОВЛЮЄТЕСЬ після того, як людина відповіла на ваші питання.
Прочитайте qa.json для відповідей. Продовжуйте з того місця, де зупинилися.
Ваша попередня робота збережена в handoff.md та git history."
```

---

## 5. Зміни оркестратора (`foundry-run.sh`)

### 5.1 Обробка Exit Code агента

```bash
run_agent() {
  # ... існуючий код ...

  local exit_code=$?

  case $exit_code in
    0)   # Успіх — продовжити до наступного агента ;;
    75)  # Очікування відповіді
         handle_waiting_answer "$agent" "$task_dir"
         return 75 ;;
    124) # Таймаут ;;
    *)   # Помилка ;;
  esac
}
```

### 5.2 Resume команда

```bash
# foundry resume-qa <slug>
resume_qa() {
  local slug="$1"
  local task_dir="tasks/${slug}--foundry"

  # Перевірити що всі blocking питання мають відповіді
  local blocking_unanswered
  blocking_unanswered=$(jq '[.questions[] | select(.priority == "blocking" and .answer == null)] | length' "$task_dir/qa.json")

  if [[ "$blocking_unanswered" -gt 0 ]]; then
    log_error "$blocking_unanswered blocking питань все ще без відповіді"
    return 1
  fi

  # Синхронізувати відповіді qa.json назад в handoff.md
  sync_qa_to_handoff "$task_dir"

  # Оновити стан та запустити resume
  foundry_set_state_status "$task_dir" "in_progress"
  local resume_agent=$(jq -r '.waiting_agent' "$task_dir/state.json")
  foundry_update_state_field "$task_dir" "resume_from" "$resume_agent"
  run_from_resume "$task_dir" "$resume_agent"
}
```

---

## 6. TUI Монітор: Q&A View

### 6.1 Новий режим перегляду: `qa`

Коли задача в стані `waiting_answer`, TUI показує Q&A editor view.

### 6.2 Розкладка

```
┌─ Q&A: task-slug ─────────────────────────────────────────────────┐
│                                                                   │
│  ┌─ Питання (u-architect) ──────────┐  ┌─ Відповідь ───────────┐ │
│  │                                  │  │                        │ │
│  │  ► Q1 [blocking] *              │  │  edge-auth — ми        │ │
│  │    Яку auth систему потрібно     │  │  мігруємо від          │ │
│  │    змінити?                      │  │  internal JWT в        │ │
│  │    Варіанти:                     │  │  наступному кварталі.  │ │
│  │    • edge-auth (Traefik)        │  │  Змінюємо тільки       │ │
│  │    • internal JWT (brama-core)  │  │  Traefik middleware.    │ │
│  │    • обидві                     │  │                        │ │
│  │                                  │  │                        │ │
│  │    Q2 [non-blocking]            │  │                        │ │
│  │    REST конвенція іменування?    │  │                        │ │
│  │    Варіанти:                     │  │    █                   │ │
│  │    • /api/v1/resources          │  │                        │ │
│  │    • /api/resources             │  │                        │ │
│  │                                  │  │                        │ │
│  └──────────────────────────────────┘  └────────────────────────┘ │
│                                                                   │
│  * = без відповіді    ► = вибрано                                 │
│  ↑↓ Навігація питаннями │ Enter/Shift+Enter: новий рядок         │
│  Esc: зберегти і вийти  │ Ctrl+Enter: зберегти та запустити       │
│  Tab: переключити фокус │ 1-9: швидкий вибір варіанту             │
└───────────────────────────────────────────────────────────────────┘
```

### 6.3 Модель взаємодії

| Клавіша | Дія |
|---------|-----|
| `↑` / `↓` | Навігація між питаннями (ліва панель) |
| `Enter` | Новий рядок в тексті відповіді |
| `Shift+Enter` | Новий рядок (альтернатива) |
| `Tab` | Переключити фокус між списком питань і редактором відповідей |
| `1`-`9` | Швидкий вибір варіанту з пропозицій агента |
| `Esc` | Зберегти відповіді в `qa.json` та повернутися до списку задач |
| `Ctrl+Enter` | Зберегти відповіді ТА відразу відновити пайплайн |
| `Ctrl+S` | Зберегти відповіді без виходу |

### 6.4 Збереження стану

- Переключення між питаннями зберігає набраний текст (буфер per-question)
- Відповіді автозберігаються в draft файл (`qa-draft.json`) кожні 5 секунд
- На `Esc` або `Ctrl+Enter` — draft фіналізується в `qa.json`
- Якщо TUI закрився випадково — draft можна відновити

### 6.5 Валідація відповідей

- **Blocking** питання показують маркер `*` і не можуть бути пропущені для `Ctrl+Enter` (resume)
- `Esc` (тільки зберегти) дозволяє часткові відповіді
- `Ctrl+Enter` перевіряє що всі blocking питання мають відповіді

### 6.6 Інтеграція зі списком задач

```
 ● task-slug-one          in_progress   u-coder      0:12:34
 ? task-slug-two          waiting       u-architect   2 питання (0/2 відповіли)
 ✓ task-slug-three        completed     —             0:45:12
```

Натискання `Enter` на `waiting_answer` задачі одразу відкриває Q&A view.

---

## 7. Артефакти агентів та протокол Summary

### 7.1 Обов'язкові артефакти

Кожен агент ПОВИНЕН створити артефакти в `tasks/<slug>--foundry/artifacts/<agent>/`:

| Артефакт | Обов'язковий | Опис |
|----------|-------------|------|
| `result.json` | так | Структурований результат: статус, метрики, ключові рішення |
| `changes.md` | якщо є зміни | Резюме змінених файлів та причини |
| `questions.json` | якщо є питання | Екстрактується в task-level `qa.json` |

### 7.2 Самооцінка агента (в `result.json`)

```json
{
  "agent": "u-coder",
  "status": "done",
  "confidence": 0.85,
  "assessment": {
    "what_went_well": [
      "Успішно реалізовано всі 3 endpoints",
      "Перевикористано існуючий auth middleware патерн"
    ],
    "what_went_wrong": [
      "Довелося вгадувати тип колонки — вибрав VARCHAR(255), але JSONB може бути краще"
    ],
    "improvement_suggestions": [
      "Опис задачі має вказувати типи даних для нових полів",
      "Було б корисно мати приклад API відповіді в специфікації"
    ],
    "blocked_by": [],
    "deviations_from_spec": [
      "Додано індекс на created_at (не в специфікації, але потрібно для продуктивності запитів)"
    ]
  },
  "metrics": {
    "files_modified": 12,
    "lines_added": 340,
    "lines_removed": 45,
    "tests_added": 5
  }
}
```

### 7.3 Протокол Summarizer

Агент `u-summarizer`:

1. **Читає** всі `result.json` з `artifacts/`
2. **Читає** `qa.json` для включення Q&A в summary
3. **Читає** `handoff.md` для повної картини пайплайну
4. **Створює** `summary.md` з:
   - Загальний результат
   - Звіт по кожному агенту (confidence, well/issues, cost)
   - Таблиця Q&A
   - Загальна вартість
   - Рекомендації на наступний цикл (процесні покращення, спостереження по моделях)

---

## 8. Вимоги до агентів

### 8.1 Базові вимоги (ВСІ агенти)

Кожен агент Foundry ПОВИНЕН:

1. **Читати контекст задачі** з секції `CONTEXT` промпту (за Context Contract)
2. **Оновлювати handoff.md** зі змінами статусу
3. **Створювати `result.json`** в `artifacts/<agent>/` з самооцінкою
4. **Обробляти Q&A протокол**: вміти записувати питання в `qa.json` та читати відповіді при resume
5. **Бути resumable**: при resume читати попередній стан з handoff.md та qa.json
6. **Звітувати чесно**: рівень впевненості, що пішло не так, відхилення від специфікації
7. **Виходити коректно**: `0` — успіх, `75` — waiting_answer, інше — помилка
8. **Поважати бюджет**: перевіряти `PIPELINE_TOKEN_BUDGET_<AGENT>` env var

### 8.2 HITL протокол (додається до `.md` кожного агента)

```markdown
## Human-in-the-Loop Protocol

Коли ви стикаєтесь з ситуацією, де не можете продовжити без людського введення:

1. Запишіть питання в `qa.json` в директорії задачі:
   - Використовуйте priority `blocking` тільки якщо реально не можете продовжити
   - Використовуйте priority `non-blocking` для переваг або оптимізацій
   - Надавайте `options` де можливо
   - Включайте `context` з релевантними шляхами файлів

2. Оновіть свою секцію в `handoff.md`:
   - Встановіть статус `waiting_answer`
   - Додайте Q&A резюме

3. Завершіть з exit code 75

4. При resume:
   - Прочитайте відповіді з `qa.json`
   - Продовжуйте роботу з урахуванням відповідей
   - НЕ перепитуйте вже відповідні питання
```

---

## 9. CLI команди

### 9.1 Нові команди

```bash
# Відповісти на питання інтерактивно (відкриває TUI Q&A view)
foundry answer <slug>

# Resume після відповідей (валідує blocking питання)
foundry resume-qa <slug>

# Список задач, що чекають відповіді
foundry waiting

# Швидка відповідь з CLI (неінтерактивно)
foundry answer <slug> --question q-001 --answer "Використати edge-auth"
```

---

## 10. Зміни файлів

| Файл | Зміна |
|------|-------|
| `lib/foundry-common.sh` | Додати `waiting_answer` до валідних станів, `handle_waiting_answer()`, `resume_qa()` |
| `lib/foundry-run.sh` | Обробка exit code 75, inject resume context, Q&A sync в handoff, agent-to-agent ескалація |
| `lib/foundry-telegram.sh` | Новий: shell-рівень нотифікації для HITL подій (curl-based) |
| `foundry` | Нові команди: `answer`, `resume-qa`, `waiting`, `telegram-qa` |
| `telegram-qa/` | **Нова директорія**: standalone Grammy бот для двостороннього Telegram Q&A |
| `telegram-qa/src/bot.ts` | Entry point бота: polling, inline keyboards, обробка відповідей |
| `telegram-qa/src/qa-bridge.ts` | Читання/запис qa.json, тригер `foundry resume-qa` |
| `telegram-qa/src/formatter.ts` | Форматування питань як Telegram повідомлень з inline кнопками |
| `monitor/src/components/App.tsx` | Додати `qa` view mode, індикатор `waiting_answer` |
| `monitor/src/components/QAView.tsx` | Новий компонент: Q&A split-panel editor |
| `monitor/src/lib/tasks.ts` | Парсинг `qa.json`, управління drafts |
| `.opencode/pipeline/handoff-template.md` | Додати Q&A секцію в шаблон |
| `.opencode/agents/u-*.md` | Додати HITL протокол до всіх агентів |
| `.opencode/agents/CONTEXT-CONTRACT.md` | Документувати правила доступу до qa.json |

---

## 11. Міграція та зворотна сумісність

- Існуючі задачі без `qa.json` працюють нормально
- `waiting_answer` — новий стан, старі версії монітора покажуть його як unknown
- Exit code 75 раніше трактувався як generic failure — тепер має специфічне значення
- Агенти без HITL протоколу ніколи не повернуть exit 75 — поведінка не зміниться
- Розгортання: додаємо протокол до агентів по одному, починаючи з `u-architect`

---

## 12. Standalone Telegram Q&A Bot

### 12.1 Принцип: Незалежність пайплайну

Workflow пайплайну НЕ ПОВИНЕН залежати від продуктових сервісів (brama-core, OpenClaw, dev-reporter-agent). Якщо платформа впала — пайплайн все одно працює. Тому HITL Telegram інтеграція — це **standalone легкий бот** що живе повністю в `agentic-development/`.

> **Reference**: [Tommertom/opencode-telegram](https://github.com/Tommertom/opencode-telegram) — Grammy-based Telegram бот з OpenCode інтеграцією. Корисний як архітектурний reference для session management та PTY handling.

### 12.2 Архітектура

```
agentic-development/
  telegram-qa/
    src/
      bot.ts              ← Grammy бот: polling, inline keyboards, обробка відповідей
      qa-bridge.ts        ← Читання/запис qa.json, тригер resume
      formatter.ts        ← Форматування питань як Telegram повідомлень
    package.json          ← Grammy + мінімум залежностей
    tsconfig.json
  lib/
    foundry-telegram.sh   ← Shell-рівень: send-only нотифікації через curl (існуючий send_telegram + нові події)
```

**Два незалежних шари**:

| Шар | Технологія | Напрямок | Залежність |
|-----|-----------|----------|------------|
| **Нотифікації** (існуючий) | `curl` → Telegram Bot API | Односторонній: pipeline → людина | Тільки `PIPELINE_TELEGRAM_BOT_TOKEN` + `PIPELINE_TELEGRAM_CHAT_ID` |
| **Q&A Bot** (новий) | Grammy + long polling | Двосторонній: pipeline ↔ людина | Standalone Node.js процес, читає/пише `qa.json` напряму |

### 12.3 Життєвий цикл Q&A Bot

```bash
# Запускається автоматично foundry коли спрацьовує waiting_answer
# АБО вручну:
foundry telegram-qa start

# Працює як фоновий процес, завершується коли немає очікуючих задач
# Авто-стоп після idle timeout (конфігурується, за замовчуванням 30 хв)
```

Бот **ефемерний** — стартує коли потрібен, зупиняється коли idle. Не постійний сервіс.

### 12.4 Telegram Q&A Flow

```
1. Агент завершується з exit code 75 (waiting_answer)
       │
2. Оркестратор запускає handle_waiting_answer()
       │
3. Спроба agent-to-agent вирішення (u-architect)
       │ (якщо не вирішено)
       ▼
4. foundry-telegram.sh надсилає нотифікацію:
   ┌──────────────────────────────────────────┐
   │ ❓ u-architect потребує вашого введення    │
   │ 📋 implement-user-auth                   │
   │                                          │
   │ Q1 [blocking]: Яку auth систему?         │
   │ • edge-auth (Traefik)                    │
   │ • internal JWT (brama-core)              │
   │ • обидві                                 │
   │                                          │
   │ [edge-auth] [JWT] [обидві] [написати]    │
   └──────────────────────────────────────────┘
       │
5. telegram-qa бот починає слухати (якщо ще не запущений)
       │
6. Користувач натискає inline кнопку АБО пише текст
       │
7. Бот записує відповідь в qa.json:
   { "answer": "edge-auth", "answered_by": "human",
     "answer_source": "telegram" }
       │
8. Якщо всі blocking питання відповідні:
   Бот викликає: foundry resume-qa <slug>
       │
9. Пайплайн відновлюється. Бот надсилає підтвердження:
   "✅ Відновлення implement-user-auth з u-architect..."
```

### 12.5 Inline Keyboard для варіантів

Коли агент надає `options` в qa.json, бот рендерить їх як inline keyboard кнопки:

```typescript
// telegram-qa/src/formatter.ts
function formatQuestion(q: Question): { text: string; keyboard: InlineKeyboard } {
  const text = [
    `❓ <b>Q${q.id}</b> [${q.priority}]`,
    q.question,
    q.context ? `\n📎 ${q.context}` : "",
  ].join("\n");

  const keyboard = new InlineKeyboard();
  if (q.options) {
    q.options.forEach((opt, i) => {
      keyboard.text(opt, `answer:${q.id}:${i}`).row();
    });
  }
  keyboard.text("📝 Написати відповідь", `custom:${q.id}`);

  return { text, keyboard };
}
```

### 12.6 Навігація по кількох питаннях

Для задач з кількома питаннями бот надсилає одне повідомлення на питання з навігацією:

```
Повідомлення 1/3:
❓ Q1 [blocking]: Яку auth систему?
[edge-auth] [JWT] [обидві]
[📝 Написати] [⏭ Наступне]

Повідомлення 2/3:
❓ Q2 [non-blocking]: REST конвенція?
[/api/v1/resources] [/api/resources]
[📝 Написати] [⏮ Попер.] [⏭ Наступне]

Повідомлення 3/3:
❓ Q3 [blocking]: Період зберігання даних?
[📝 Написати] [⏮ Попер.]
[✅ Надіслати всі відповіді]
```

### 12.7 Налаштування

```bash
# .env.local — потрібно лише дві змінні для нотифікацій
PIPELINE_TELEGRAM_BOT_TOKEN=<токен від @BotFather>
PIPELINE_TELEGRAM_CHAT_ID=<ID чату або групи>

# Опціонально: дозволені user IDs для Q&A бота (безпека)
PIPELINE_TELEGRAM_ALLOWED_USERS=123456789,987654321
```

**Кроки**:
1. Створити бота через @BotFather → отримати токен
2. Написати боту, потім `https://api.telegram.org/bot<TOKEN>/getUpdates` → отримати chat_id
3. Встановити обидві змінні в `.env.local`
4. `cd agentic-development/telegram-qa && npm install` (одноразово)
5. Пайплайн автоматично стартує бот коли виникає `waiting_answer`

**Без залежності від**: brama-core, OpenClaw, dev-reporter-agent, Docker, bootstrap.sh

### 12.8 Події нотифікацій (shell-рівень, curl-based)

Працюють навіть без запущеного Q&A бота — чистий `send_telegram()` через curl:

| Подія | Повідомлення | Пріоритет |
|-------|-------------|-----------|
| `waiting_answer` спрацював | `"❓ <b>{agent}</b> потребує введення\n📋 {task}\n🔢 {N} питань\n\nfoundry answer {slug}"` | Високий |
| Всі питання відповідні | `"✅ Питання для <b>{task}</b> відповідні\nВідновлення з {agent}..."` | Інфо |
| Наближення таймауту | `"⏰ <b>{task}</b> чекає {duration} — {N} невідповідних"` | Попередження (50% і 90%) |
| Agent-to-agent вирішено | `"🤖 <b>{answering_agent}</b> відповів на питання {asking_agent} внутрішньо"` | Інфо |
| Ескалація до людини | `"❓ Питання <b>{agent}</b> ескальоване до людини\n📋 {task}"` | Високий |

### 12.9 Graceful Degradation

| Сценарій | Поведінка |
|----------|----------|
| Telegram токен не налаштований | Нотифікації мовчки пропускаються, Q&A тільки через TUI |
| Бот не може стартувати (node відсутній) | Fallback на нотифікації + TUI Q&A |
| Бот впав посеред сесії | Відповіді в qa.json збережені; перезапустити бот або TUI |
| Користувач відповів через TUI поки бот працює | Бот бачить зміни qa.json, оновлює Telegram повідомлення |
| Користувач відповів через Telegram поки TUI відкритий | TUI бачить зміни qa.json на наступному refresh cycle |

---

## 13. Стратегія таймауту очікування

### 13.1 Варіанти таймауту

| Стратегія | Поведінка | Коли використовувати |
|-----------|----------|---------------------|
| **Без таймауту** (`timeout: 0`) | Чекати нескінченно | Низькопріоритетні задачі, non-blocking питання |
| **М'який таймаут** (`timeout: 4h`, за замовчуванням) | Нагадування на 50% і 90%, потім auto-fail | Стандартні задачі |
| **Жорсткий таймаут** (`timeout: 1h`) | Негайний auto-fail по закінченню | Часочутливі задачі, CI/CD |
| **Авто-пропуск** (`timeout: 2h, on_timeout: skip`) | Пропустити очікуючого агента, продовжити пайплайн | Коли питання — non-blocking перевага |

### 13.2 Що відбувається коли таймаут закінчився

```
таймаут досягнуто
    ├── on_timeout: "fail" (за замовчуванням)
    │   ├── Статус задачі → "failed"
    │   ├── stop_reason → "qa_timeout"
    │   ├── Event: "qa_timeout"
    │   ├── Telegram: "⏰ Пайплайн TIMEOUT очікуючи відповіді"
    │   └── Задачу можна відновити пізніше: `foundry resume-qa <slug>`
    │
    ├── on_timeout: "skip"
    │   ├── Позначити невідповідні питання як skipped
    │   ├── Статус агента → "skipped_qa"
    │   ├── Продовжити пайплайн з наступним агентом
    │   ├── Summarizer відзначає пропущені питання
    │   └── Follow-up задача рекомендована для невідповідних
    │
    └── on_timeout: "fallback"
        ├── Використати найкращу здогадку агента (якщо є default_answer в qa.json)
        ├── Позначити відповіді як "auto:agent_default"
        ├── Продовжити пайплайн
        └── Summarizer позначає auto-відповідні питання для перевірки
```

### 13.3 Конфігурація

В `pipeline-plan.json` або профілі:
```json
{
  "qa_timeout": "4h",
  "qa_on_timeout": "fail",
  "qa_reminder_at": ["50%", "90%"]
}
```

Per-question override в `qa.json`:
```json
{
  "id": "q-001",
  "timeout": "1h",
  "on_timeout": "fallback",
  "default_answer": "Використати edge-auth (безпечний дефолт)"
}
```

---

## 14. Agent-to-Agent Q&A ескалація

### 14.1 Ланцюг ескалації

Перед тим як дійти до людини, питання проходять ланцюг ескалації:

```
Агент що питає (напр. u-coder)
    │
    ▼
u-architect (перший відповідач — знає специфікацію)
    │
    ├── Може відповісти? → Записує відповідь в qa.json, пайплайн продовжує
    │                       Лог: "agent_qa_resolved" event
    │
    └── Не може відповісти? → Ескалація до людини
                               Лог: "agent_qa_escalated" event
                               Статус → waiting_answer
```

### 14.2 Чому u-architect першим

- `u-architect` створює специфікацію — має найглибше розуміння наміру задачі
- Багато питань coder/validator/tester — це уточнення по специфікації
- Зменшує людські переривання для питань, на які специфікація вже відповідає (але агент що питає пропустив)

### 14.3 Реалізація

Коли агент завершується з exit code 75:

```bash
handle_waiting_answer() {
  local agent="$1"
  local task_dir="$2"

  # Крок 1: Спроба agent-to-agent вирішення
  if [[ "$agent" != "u-architect" ]]; then
    log_info "Спроба agent-to-agent Q&A вирішення через u-architect"

    # Промпт з питаннями
    local qa_prompt="Переглянь ці питання від ${agent} і відповідай на ті що можеш.
    Для питань на які можеш відповісти: заповни поле 'answer'.
    Для питань на які не можеш: залиш 'answer' як null.
    Прочитай qa.json та оригінальну специфікацію задачі."

    # Запуск u-architect в Q&A mode (короткий таймаут, дешевша модель OK)
    run_agent "u-architect" "$qa_prompt" \
      --timeout 300 \
      --mode "qa-responder" \
      --context "$task_dir/qa.json"

    # Перевірка чи всі blocking питання тепер мають відповіді
    local still_unanswered
    still_unanswered=$(jq '[.questions[] | select(.priority == "blocking" and .answer == null)] | length' "$task_dir/qa.json")

    if [[ "$still_unanswered" -eq 0 ]]; then
      # Все вирішено агентом!
      pipeline_task_append_event "$task_dir" "agent_qa_resolved" \
        "u-architect відповів на всі blocking питання від $agent" "$agent"
      send_telegram "🤖 <b>u-architect</b> вирішив питання від <b>${agent}</b> внутрішньо"
      return 0  # Продовжити пайплайн
    fi

    # Часткове вирішення — логуємо що відповідне
    local total=$(jq '.questions | length' "$task_dir/qa.json")
    local answered=$(jq '[.questions[] | select(.answer != null)] | length' "$task_dir/qa.json")
    pipeline_task_append_event "$task_dir" "agent_qa_partial" \
      "u-architect відповів на $answered/$total питань, ескалація решти до людини" "$agent"
  fi

  # Крок 2: Ескалація до людини
  escalate_to_human "$agent" "$task_dir"
}
```

### 14.4 Запис Q&A в qa.json

Відповіді агентів відрізняються від відповідей людини:

```json
{
  "id": "q-001",
  "agent": "u-coder",
  "question": "Яку auth систему?",
  "answer": "edge-auth — згідно специфікації секція 3.2, ми змінюємо тільки Traefik middleware",
  "answered_at": "2026-03-26T14:35:00Z",
  "answered_by": "u-architect",
  "answer_source": "agent"
}
```

vs відповідь людини:
```json
{
  "answer": "edge-auth, ми мігруємо від JWT",
  "answered_by": "human",
  "answer_source": "human"
}
```

### 14.5 Інтеграція з Handoff та Summary

Всі Q&A взаємодії (agent-to-agent ТА людські) записуються в:

1. **`qa.json`** — структуровано, з полями `answered_by` та `answer_source`
2. **`handoff.md`** — форматована Q&A секція з зазначенням хто відповів:

```markdown
### Q&A

> **Q1** [blocking] Яку auth систему? (запитав u-coder)
> **A1** (від u-architect): edge-auth — згідно специфікації секція 3.2
>
> **Q2** [blocking] Політика зберігання даних? (запитав u-coder)
> **A2** (від людини): 90 днів, потім архів у cold storage
```

3. **`summary.md`** — виділена секція:

```markdown
## Лог Q&A

| # | Запитав | Питання | Відповів | Відповідь | Вплив |
|---|---------|---------|----------|-----------|-------|
| 1 | u-coder | Яку auth систему? | u-architect | edge-auth за специфікацією 3.2 | Обмежено до Traefik |
| 2 | u-coder | Зберігання даних? | людина | 90 днів + архів | Додано cleanup cron job |

### Рівень Agent-to-Agent вирішення
- 1 з 2 питань вирішено без людського втручання (50%)

## Специфікація
- **Створена**: u-architect
- **Файл**: `artifacts/u-architect/openspec.md`
- **Ключові рішення**: [список зі специфікації]
```

---

## 15. Шаблони питань — Відкладено (Майбутнє)

### 15.1 Рішення: Без шаблонів зараз

Шаблони питань **відкладені** на майбутню ітерацію. Обґрунтування:

- Шаблони ризикують створити **хибнопозитивні питання** — агенти можуть ставити шаблонні питання навіть коли відповідь очевидна з контексту
- Це підриває мету автономних агентів — ми не хочемо "підводити свідка"
- Поточний підхід: агенти ставлять питання тільки коли реально заблоковані

### 15.2 Майбутнє: Precision Questions (Плановано)

Майбутній механізм де **питання допомагають моделі не робити помилки** замість збору інформації:

```json
{
  "type": "precision_check",
  "question": "Я збираюся додати міграцію що видаляє колонку 'legacy_auth'. Бачу що вона ще використовується в UserRepository.php рядок 45. Продовжувати чи це false positive від мертвого коду?",
  "auto_answer_if": "grep -r 'legacy_auth' --include='*.php' | wc -l == 1"
}
```

Ключові відмінності від звичайного Q&A:
- **Мета**: запобігти помилкам, а не зібрати інформацію
- **Тригер**: агент виявляє ризиковану операцію і самоперевіряється
- **Авто-вирішення**: може включати команду верифікації що автовідповідає
- **Без шаблонів**: питання генеруються динамічно з реального аналізу коду

Буде специфіковано в окремому OpenSpec коли базова HITL система буде доведена.

---

## 16. Мульти-агентні одночасні питання

### 16.1 Підтверджено: Кілька агентів можуть мати pending питання

Коли `continue_on_wait: true` в профілі, кілька агентів можуть накопичувати питання:

```json
{
  "questions": [
    {"id": "q-001", "agent": "u-architect", "question": "..."},
    {"id": "q-002", "agent": "u-architect", "question": "..."},
    {"id": "q-003", "agent": "u-coder", "question": "..."},
    {"id": "q-004", "agent": "u-tester", "question": "..."}
  ]
}
```

### 16.2 Групування в TUI

Питання групуються по агентах в Q&A view:

```
┌─ Питання ────────────────────────┐
│                                  │
│  ▸ u-architect (2 питання)       │
│    ► Q1 [blocking] *            │
│      Q2 [non-blocking]          │
│                                  │
│  ▸ u-coder (1 питання)          │
│      Q3 [blocking] *            │
│                                  │
│  ▸ u-tester (1 питання)         │
│      Q4 [non-blocking]          │
│                                  │
└──────────────────────────────────┘
```

### 16.3 Порядок Resume

Коли відповіді надані, агенти відновлюються в порядку пайплайну (architect перед coder перед tester), а не в порядку відповідей на питання.

---

## 17. Зведення прийнятих рішень

| # | Питання | Рішення | Обґрунтування |
|---|---------|---------|---------------|
| 1 | Telegram нотифікації | **Так** — використати існуючу інфраструктуру `send_telegram()` + dev-reporter-agent | Вже побудовано, потрібні лише нові тригери подій |
| 2 | Таймаут очікування | **М'який таймаут 4h за замовчуванням** з конфігурованими стратегіями (fail/skip/fallback) | Баланс між терміновістю та асинхронним стилем роботи |
| 3 | Мульти-агентні питання | **Так** — кілька агентів можуть мати pending питання | Природний наслідок режиму `continue_on_wait` |
| 4 | Agent-to-agent Q&A | **Так** — спочатку u-architect, потім ескалація до людини | Зменшує людські переривання; architect найкраще знає специфікацію |
| 5 | Шаблони питань | **Ні** (відкладено) — ризик хибнопозитивних питань | Майбутній механізм "precision questions" планується замість цього |
