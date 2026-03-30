# Task Summary: Delete all legacy bash scripts after TS migration is complete

## Загальний статус
- Статус пайплайну: FAIL — `u-coder` завершив основну міграцію, але `u-validator` і `u-tester` фактично не відпрацювали через `Insufficient balance`, тому валідація й тестове підтвердження лишились незавершеними
- Гілка: `pipeline/delete-all-legacy-bash-scripts-after-ts-migration`
- Pipeline ID: `20260328_201827`
- Workflow: `foundry` (`builder`)

## Telemetry
> Команда `agentic-development/lib/cost-tracker.sh summary-block --workflow builder --task-slug "delete-all-legacy-bash-scripts-after-ts-migration"` не виконалась, бо `agentic-development/lib/cost-tracker.sh` вже видалено в межах цієї задачі; нижче наведено fallback-вивід із `render-summary.ts`.

**Workflow:** Foundry

_No telemetry records for delete-all-legacy-bash-scripts-after-ts-migration_

## Агенти
### u-planner
- Що зробив: класифікував задачу як `standard`, визначив scope в `agentic-development`, запланував ланцюжок `u-coder -> u-validator -> u-tester -> u-summarizer`, окремий architect не знадобився
- Які були складнощі або блокери: блокерів не зафіксовано; агент лише звернув увагу, що частина bash-залежностей ще лишається в `ultraworks.sh`, E2E-спеках і документації
- Що залишилось виправити або доробити: сам план доробок не потребував; потрібне фактичне завершення етапів валідації та тестування

### u-coder
- Що зробив: прибрав `runBashLib()` і `LIB_DIR` з `agentic-development/monitor/src/cli/foundry.ts`, перевів `retry/cleanup/stats/setup` на TS-реалізації, оновив `agentic-development/monitor/src/cli/batch.ts` на `runPipeline()`, змінив `agentic-development/monitor/src/lib/actions.ts` і `agentic-development/monitor/src/lib/normalize-summary.ts`, видалив 7 застарілих bash-скриптів
- Які були складнощі або блокери: явних блокерів у власній роботі не було; агент свідомо не видалив `foundry-common.sh`, `foundry-cleanup.sh`, `foundry-preflight.sh`, `foundry-telegram.sh`, `env-check.sh`, `foundry-e2e.sh`, бо вони все ще referenced у `agentic-development/ultraworks.sh` та E2E-спеках; self-assessment: confidence `0.92`, що спрацювало добре — TS-компіляція проходила, міграція CLI завершена; що лишилось — дочистити зовнішні bash-залежності
- Що залишилось виправити або доробити: окремо мігрувати `ultraworks.sh` і E2E-тести з bash-залежностей, а також вирішити долю `agentic-development/lib/foundry-e2e.sh`

### u-validator
- Що зробив: агент стартував, але повноцінної перевірки не виконав; `result.json` не створено, у логах є лише помилка білінгу
- Які були складнощі або блокери: blocking issue — `Insufficient balance`; через це не були запущені очікувані compile/style/check кроки, а `checkpoint.json` позначив етап як `done`, що не збігається з фактичним логом
- Що залишилось виправити або доробити: повторно прогнати валідацію після відновлення білінгу й зафіксувати реальний артефакт результату

### u-tester
- Що зробив: агент стартував, але тестовий прогін не відбувся; `result.json` відсутній, у логах — тільки помилка білінгу
- Які були складнощі або блокери: blocking issue — `Insufficient balance`; через це не підтверджено вимогу прогнати `npx vitest run` і CLI smoke-команди після видалення bash-скриптів
- Що залишилось виправити або доробити: після відновлення білінгу заново виконати тестовий етап і перевірити `foundry run/headless/retry/cleanup/stats/setup`

## Що треба доробити
- Повторно виконати `u-validator` і `u-tester`, бо фактична валідація та тестування не відбулися
- Перевірити CLI-сценарії з task constraints: `foundry run`, `foundry headless`, `foundry retry`, `foundry cleanup`, `foundry stats`, `foundry setup`
- Мігрувати bash-залежності, які ще тримають у репозиторії `foundry-common.sh`, `foundry-cleanup.sh`, `foundry-preflight.sh`, `foundry-telegram.sh`, `env-check.sh`
- Оновити E2E-спеки й helper-и, що досі викликають bash preflight/common helpers

## Рекомендації по оптимізації

### 🔴 Збій пайплайну: `u-validator` і `u-tester` зупинились на білінгу
**Що сталось:** обидва агенти завершились помилкою `Insufficient balance`, тому етапи валідації й тестування фактично не були виконані, хоча `checkpoint.json` позначив їх як `done`.
**Вплив:** пайплайн залишився неповним; немає достовірного підтвердження, що TS-міграція проходить усі required checks, а статуси в checkpoint вводять в оману.
**Рекомендація:** додати fail-fast перевірку доступного балансу перед запуском наступних агентів і записувати фактичний `failed`/`blocked` статус у checkpoint.

### 🟡 Аномалія токенів: дуже великий обсяг кешованого контексту у `u-coder`
**Що сталось:** `u-coder` використав приблизно `8,933,204` `cache_read` токенів, `u-planner` — близько `517,135`; це суттєво перевищує поріг `500K` на агента.
**Вплив:** зростають вартість і latency пайплайну, а агент читає значно ширший контекст, ніж потрібно для точкової cleanup-задачі.
**Рекомендація:** жорсткіше обмежувати read-scope в planner prompt, передавати coder-у короткий curated список файлів і винести великі історичні документи/аудити з дефолтного контексту.

### 🟡 Розрив у телеметрії: summary-команда посилається на вже видалений скрипт
**Що сталось:** запитана команда `agentic-development/lib/cost-tracker.sh summary-block ...` більше не існує, бо `cost-tracker.sh` видалено в межах цієї ж задачі; fallback `render-summary.ts` повернув порожній блок.
**Вплив:** фінальний звіт не містить нормальної telemetry-таблиці, а summarizer workflow частково застарів щодо поточного TS-стану Foundry.
**Рекомендація:** оновити інструкції summarizer/pipeline так, щоб вони завжди викликали `npx tsx agentic-development/monitor/src/cli/render-summary.ts ...` або інший підтримуваний TS entrypoint.

## Пропозиція до наступної задачі
- Назва задачі: Мігрувати `ultraworks.sh` та E2E-спеки з залишкових Foundry bash-залежностей на TypeScript
- Чому її варто створити зараз: саме ці посилання блокують остаточне видалення `foundry-common.sh`, `foundry-cleanup.sh`, `foundry-preflight.sh`, `env-check.sh` і частини legacy shell-surface після успішної cleanup-фази coder-а
- Очікуваний результат: `ultraworks.sh` та E2E helper/spec-и працюють без legacy bash helper-ів, після чого можна завершити видалення решти shell-скриптів і спростити pipeline/tooling документацію
