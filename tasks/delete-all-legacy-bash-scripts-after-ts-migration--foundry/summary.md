# Task Summary: Delete all legacy bash scripts after TS migration is complete

## Загальний статус
- Статус пайплайну: FAIL - PIPELINE INCOMPLETE
- Гілка: `pipeline/delete-all-legacy-bash-scripts-after-ts-migration`
- Pipeline ID: `20260329_060709`
- Workflow: `foundry`

## Telemetry
**Workflow:** Foundry

_No telemetry records for delete-all-legacy-bash-scripts-after-ts-migration_

## Агенти
### u-planner
- Що зробив: оцінив scope cleanup-задачі, підтвердив наявність TS-еквівалентів і записав `pipeline-plan.json` з профілем `standard`.
- Які були складнощі або блокери: блокерів не було; був лише технічний повторний запис `pipeline-plan.json` після обов'язкового read-before-write.
- Що залишилось виправити або доробити: по етапу планування критичних хвостів немає.

### u-coder
- Що зробив: видалив legacy bash-скрипти з `agentic-development/lib/` і `agentic-development/foundry-legacy.sh`, прибрав `runBashLib()` і `LIB_DIR` з `foundry.ts`, переписав `cleanZombies()` на TypeScript, замінив виклик `cost-tracker.sh` на прямий `render-summary.ts`, оновив `agentic-development/CONVENTIONS.md` і `.claude/skills/foundry/SKILL.md`.
- Які були складнощі або блокери: видалені скрипти ще згадуються в legacy bash/playwright тестах; для `npx vitest run` це не стало блокером, але залишило технічний борг.
- Що залишилось виправити або доробити: оновити або прибрати legacy тести, що ще посилаються на видалені скрипти; окремо лишився `agentic-development/lib/foundry-e2e.sh`, який ще не перенесений на TS.

### u-validator
- Що зробив: перевірив фактичний TypeScript scope змін, підтвердив `npm run build` PASS і зафіксував, що 7 падінь у Vitest були pre-existing.
- Які були складнощі або блокери: блокерів не було; інструкція валідації була орієнтована на PHP/Python apps, хоча task змінював `agentic-development/monitor`.
- Що залишилось виправити або доробити: за потреби додати окремі lint/cs-check таргети для `agentic-development/monitor`, щоб наступна валідація була однорідною.

### u-tester
- Що зробив: тестову фазу фактично не виконав; у логах є лише старт агента і помилка білінгу, `result.json` відсутній.
- Які були складнощі або блокери: blocking issue - `Insufficient balance`; це зупинило tester-етап.
- Що залишилось виправити або доробити: після відновлення балансу треба повторно запустити `u-tester` і завершити незалежну тестову перевірку.

## Що треба доробити
- Перезапустити `u-tester` після відновлення балансу й отримати коректний `artifacts/u-tester/result.json`.
- Оновити legacy тести в `agentic-development/tests/`, які ще викликають `foundry-common.sh`, `foundry-preflight.sh`, `foundry-run.sh`, `cost-tracker.sh` і `env-check.sh`.
- Перенести `agentic-development/lib/foundry-e2e.sh` на TypeScript або явно зафіксувати його як дозволений виняток у документації та тестах.

## Рекомендації по оптимізації
### 🔴 Pipeline FAIL/INCOMPLETE: tester-етап не завершився
**Що сталось:** `u-tester` зупинився з помилкою `Insufficient balance`, але в `checkpoint.json` агент усе одно позначений як `done`.
**Вплив:** пайплайн лишився без завершеної tester-фази, а глобальний статус розходиться між checkpoint, логами й артефактами.
**Рекомендація:** додати preflight-перевірку білінгу перед запуском агентів і фінальну звірку `checkpoint.json` з логами та `result.json` перед виставленням статусу `done`.

### 🟡 Cost anomaly: cleanup-задача вийшла занадто дорогою
**Що сталось:** `u-coder` витратив приблизно `$2.84`, що перевищує поріг аномалії для одного агента.
**Вплив:** простий cleanup/refactor коштує дорожче, ніж очікувано, і збільшує вартість повторних прогонів.
**Рекомендація:** звужувати контекст coder-а до конкретних шляхів `agentic-development/...` і розбивати doc/test cleanup на окремі задачі, щоб не платити за зайве repo-wide дослідження.

### 🟡 Legacy test debt: частина regression surface лишилась на видалених bash-скриптах
**Що сталось:** після видалення скриптів збереглися legacy тести, які все ще звертаються до цих файлів напряму.
**Вплив:** `npx vitest run` лишається релевантним, але старі bash/playwright сценарії тепер не узгоджені з новою TS-only архітектурою.
**Рекомендація:** окремою задачею переписати або видалити legacy тести, щоб повний test surface відповідав поточній реалізації Foundry.

## Пропозиція до наступної задачі
- Назва задачі: Мігрувати legacy тести Foundry з bash-скриптів на TypeScript API
- Чому її варто створити зараз: після видалення основних bash-скриптів саме тести лишилися головним джерелом битих посилань і заважають повністю консистентному пайплайну.
- Очікуваний результат: усі тести в `agentic-development/tests/`, що ще посилаються на видалені bash-скрипти, або переписані на TS-еквіваленти, або вилучені з regression surface.
