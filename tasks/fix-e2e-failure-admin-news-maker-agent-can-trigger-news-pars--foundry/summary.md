# Task Summary: Fix E2E failure: Admin: News-Maker Agent: can trigger news parsing from core admin settings @admin @news-maker

## Загальний статус
- Статус пайплайну: FAIL — PIPELINE INCOMPLETE, оркестратор зупинився на `u-tester`, хоча цільовий сценарій уже проходить
- Гілка: `pipeline/fix-e2e-failure-admin-news-maker-agent-can-trigger-news-pars`
- Pipeline ID: `20260324_230038`
- Workflow: `Foundry`

## Telemetry
**Workflow:** Builder

## Telemetry

| Agent | Model | Input | Output | Price | Time |
|-------|-------|------:|-------:|------:|-----:|
| u-coder | anthropic/claude-sonnet-4-6 | 45 | 9540 | $0.6347 | 39m 53s |
| u-investigator | anthropic/claude-sonnet-4-6 | 11 | 1702 | $0.1230 | 1s |
| u-planner | anthropic/claude-sonnet-4-6 | 11 | 1702 | $0.1230 | 1m 30s |
| u-tester | opencode-go/kimi-k2.5 | 38502 | 4809 | $0.0351 | 8m 45s |
| u-validator | openai/gpt-5.4 | 19243 | 1257 | $0.0698 | 55s |

## Моделі

| Model | Agents | Input | Output | Price |
|-------|--------|------:|-------:|------:|
| anthropic/claude-sonnet-4-6 | u-coder, u-investigator, u-planner | 67 | 12944 | $0.8806 |
| openai/gpt-5.4 | u-validator | 19243 | 1257 | $0.0698 |
| opencode-go/kimi-k2.5 | u-tester | 38502 | 4809 | $0.0351 |

## Context Modifiers By Agent

_Skills, MCP tools, and commands that influenced LLM behavior._

### u-coder
- **Skill:** `coder`

### u-planner
- **Skill:** `planner`

### u-tester
- **Skill:** `tester`

### u-validator
- **Skill:** `validator`

## Tools By Agent

### u-coder
- `skill` x 1
- `read` x 8
- `glob` x 3
- `grep` x 3
- `bash` x 4

### u-investigator
- none recorded

### u-planner
- `skill` x 1
- `read` x 6
- `grep` x 3
- `write` x 1

### u-tester
- `read` x 4
- `skill` x 1
- `bash` x 8

### u-validator
- `read` x 2
- `skill` x 1
- `glob` x 1
- `grep` x 1
- `bash` x 2
- `apply_patch` x 1

## Files Read By Agent

### u-coder
- `.opencode/pipeline/reports/e2e-autofix-20260324_224029.json`
- `brama-core/tests/e2e/tests/admin/news_maker_admin_test.js`
- `brama-core/src/src/Controller/Admin/AgentSettingsController.php`
- `brama-core/src/templates/admin/agent_settings.html.twig`
- `brama-core/src/src/Controller/Api/Internal/AgentInstallController.php`
- `brama-core/src/src/Controller/Api/Internal/AgentNewsCrawlController.php`
- `brama-core/tests/e2e/tests/admin/news_digest_pipeline_test.js`
- `brama-core/src/src/AgentInstaller/AgentInstallerService.php`
- `brama-core/src/src/AgentAction/NewsCrawlTrigger.php`

### u-investigator
- none recorded

### u-planner
- `brama-core/tests/e2e/tests/admin/news_maker_admin_test.js`
- `.opencode/pipeline/reports/e2e-autofix-20260324_224029.json`
- `brama-core/tests/e2e/tests/admin/news_digest_pipeline_test.js`
- `brama-core/src/templates/admin/agent_settings.html.twig`
- `brama-core/openspec/changes/fix-remaining-e2e-failures/proposal.md`
- `brama-core/openspec/changes/fix-remaining-e2e-failures/tasks.md`
- `pipeline-plan.json`

### u-tester
- `.opencode/pipeline/handoff.md`
- `brama-core/tests/e2e/tests/admin/news_maker_admin_test.js`
- `brama-core/tests/e2e/tests/admin/news_digest_pipeline_test.js`
- `brama-core/tests/e2e/codecept.conf.js`
- `.env.e2e.devcontainer`

### u-validator
- `.opencode/agents/CONTEXT-CONTRACT.md`
- `.opencode/pipeline/handoff.md`

## Агенти
### u-planner
- Що зробив: класифікував задачу як `bugfix`, визначив ланцюжок `u-investigator → u-coder → u-validator → u-tester → u-summarizer` і помітив, що патерн фейлу повторюється ще й у `news_digest_pipeline_test.js`
- Які були складнощі або блокери: блокерів не зафіксовано
- Що залишилось виправити або доробити: нічого в межах planning-фази

### u-investigator
- Що зробив: фактично не відпрацював задачу — лог містить помилку `You must provide a message or a command`
- Які були складнощі або блокери: це блокер самої investigator-фази; root cause довелось встановлювати вже на етапі `u-coder`
- Що залишилось виправити або доробити: виправити делегацію в investigator, щоб фаза отримувала валідний prompt/context

### u-coder
- Що зробив: знайшов справжню причину E2E regression — неправильний порядок аргументів у `page.waitForFunction`; додав `null` як `arg` у `brama-core/tests/e2e/tests/admin/news_maker_admin_test.js` і `brama-core/tests/e2e/tests/admin/news_digest_pipeline_test.js`; зафіксував це в коміті `0dd37e4`
- Які були складнощі або блокери: явних блокерів у реалізації не було, але через збій `u-investigator` агент витратив багато часу на зайве дослідження
- Що залишилось виправити або доробити: сам hotfix готовий; додаткових змін у коді для цього бага не потрібно

### u-validator
- Що зробив: прогнав `make cs-check` і `make analyse`, обидві перевірки пройшли успішно; оновив handoff; коміт `dafed02`
- Які були складнощі або блокери: блокерів не зафіксовано
- Що залишилось виправити або доробити: нічого по validation-фазі

### u-tester
- Що зробив: перевірив цільовий сценарій командою `npx codeceptjs run --grep "can trigger news parsing from core admin settings"` — PASS за ~31-34с; підтвердив фікс у двох тестах; коміт `8bb450f`
- Які були складнощі або блокери: pipeline впав на `u-tester`, бо повний `@news-maker` suite все ще має 3 pre-existing фейли ізоляції стану, не пов'язані з `waitForFunction`; окремо `news_digest_pipeline_test.js` пройшов початковий збій, але зламався далі вже на очікуванні завершення pipeline crawl
- Що залишилось виправити або доробити: стабілізувати `brama-core/tests/e2e/tests/admin/news_maker_admin_test.js`, розв'язати flaky/shared-state сценарії і повторно прогнати tester+summarizer стадії

## Що треба доробити
- Усунути pre-existing shared-state проблеми в `brama-core/tests/e2e/tests/admin/news_maker_admin_test.js`, через які падає повний `@news-maker` regression
- Повторно запустити `u-tester` після стабілізації suite і дати pipeline дійти до фінального `u-summarizer` без red gate

## Рекомендації по оптимізації
> Ця секція ОБОВ'ЯЗКОВА якщо є: фейли агентів, аномальна кількість токенів (>500K на агента), аномальна тривалість (>15хв на агента), retry storm (3+ retry одного агента), pipeline FAIL/INCOMPLETE.

### 🔴 Pipeline FAIL: `u-tester` заблокував завершення задачі через сторонні E2E фейли
**Що сталось:** Цільовий сценарій виправлений і проходить, але gate на повний `@news-maker` suite впав через 3 відомі pre-existing тести із shared state.
**Вплив:** Пайплайн позначений як `FAIL`, `u-summarizer` не був завершений автоматично, а готовий hotfix завис у статусі incomplete.
**Рекомендація:** Розділити acceptance для bugfix-задачі і сторонній regression noise.
- Варіант A: полагодити ізоляцію тестових даних у `brama-core/tests/e2e/tests/admin/news_maker_admin_test.js`
- Варіант B: для autofix-задач цього типу gate-ити обов'язково цільовий сценарій + impact-сценарії, а відомі unrelated фейли виносити окремою follow-up задачею

### 🔴 Agent failure: `u-investigator` стартував без валідного prompt
**Що сталось:** Investigator завершився помилкою `You must provide a message or a command` і не передав корисного handoff.
**Вплив:** Втрачено окрему bug-analysis фазу, а `u-coder` був змушений самостійно робити розслідування, що збільшило час pipeline.
**Рекомендація:** Додати в orchestrator перевірку непорожнього prompt перед запуском `u-investigator`.
- Варіант A: fail-fast у pipeline runner, якщо investigator invocation не містить CONTEXT
- Варіант B: fallback на handoff/task prompt, якщо окреме investigator-повідомлення не згенерувалось

### 🟡 Duration anomaly: `u-coder` працював 39m 53s
**Що сталось:** Coder довго досліджував controller/template/test flow, бо початкова investigator-фаза не дала root cause, а первинна гіпотеза про backend bug виявилась хибною.
**Вплив:** Збільшився загальний час прогону і вартість найдорожчої фази.
**Рекомендація:** Звузити scope coder-фази для E2E autofix і давати їй already-triaged reproduction notes.
- Варіант A: передавати coder'у короткий verified RCA з planner/investigator
- Варіант B: для timeout-фейлів спочатку перевіряти синтаксис викликів тестового API/Playwright helper у lightweight pre-check

## Пропозиція до наступної задачі
- Назва задачі: Стабілізувати ізоляцію стану в `brama-core/tests/e2e/tests/admin/news_maker_admin_test.js`
- Чому її варто створити зараз: саме ці pre-existing фейли заблокували завершення поточного pipeline, хоча основний баг уже виправлено
- Очікуваний результат: повний `@news-maker` suite проходить детерміновано без залежності від залишкового `E2E Test Source` і майбутні autofix-пайплайни не падають на сторонніх тестах
