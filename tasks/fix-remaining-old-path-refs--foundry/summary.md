# Task Summary: Fix remaining references to old agents/ path across the repo

## Загальний статус
- Статус пайплайну: PIPELINE COMPLETE (PASS)
- Гілка: `pipeline/fix-remaining-references-to-old-agents-path-across`
- Pipeline ID: `20260324_131417`
- Workflow: `Foundry`

## Telemetry
**Workflow:** Foundry

| Agent | Model | Input | Output | Price | Time |
|-------|-------|------:|-------:|------:|-----:|
| coder | anthropic/claude-sonnet-4-6 | 65 | 17724 | $1.2884 | 6m 37s |
| planner | openai/gpt-5.4 | 69261 | 5322 | $0.2338 | 1m 20s |
| validator | openai/gpt-5.4 | 18320 | 930 | $0.0624 | 40s |

## Моделі

| Model | Agents | Input | Output | Price |
|-------|--------|------:|-------:|------:|
| anthropic/claude-sonnet-4-6 | coder | 65 | 17724 | $1.2884 |
| openai/gpt-5.4 | planner, validator | 87581 | 6252 | $0.2962 |

## Tools By Agent

### coder
- `bash` x 29
- `edit` x 22
- `glob` x 1
- `read` x 18
- `skill` x 1
- `todowrite` x 9

### planner
- `apply_patch` x 1
- `bash` x 2
- `glob` x 3
- `grep` x 1
- `read` x 22
- `skill` x 1

### validator
- `apply_patch` x 1
- `read` x 1
- `skill` x 1
- `todowrite` x 3

## Files Read By Agent

### coder
- `.devcontainer/bootstrap/install-node-deps.sh`
- `.devcontainer/bootstrap/install-php-deps.sh`
- `.devcontainer/bootstrap/run-migrations.sh`
- `.opencode`
- `.opencode/pipeline/handoff.md`
- `.opencode/skills/architect/SKILL.md`
- `.opencode/skills/coder/SKILL.md`
- `.opencode/skills/shared/devcontainer-provisioner/SKILL.md`
- `.opencode/skills/shared/security-review/SKILL.md`
- `.opencode/skills/translater/SKILL.md`
- `.opencode/skills/validator/SKILL.md`
- `Makefile`
- `agentic-development/lib/foundry-run.sh`
- `brama-core/docs/features/pipeline/ua/pipeline.md`
- `scripts/external-agent.sh`
- `scripts/validate-deployment-config.sh`
- `compose.agent-`
- `docker/compose.agent`

### planner
- `/workspaces/brama`
- `.opencode/agents/CONTEXT-CONTRACT.md`
- `.opencode/pipeline/handoff.md`
- `.opencode/pipeline/logs`
- `.opencode/pipeline/logs/20260324_125631_coder.log`
- `.opencode/pipeline/logs/20260324_125631_coder.meta.json`
- `.opencode/pipeline/logs/20260324_125631_plan.json`
- `.opencode/pipeline/logs/20260324_125631_planner.log`
- `.opencode/pipeline/logs/20260324_125631_planner.meta.json`
- `.opencode/pipeline/logs/20260324_125631_tester.log`
- `.opencode/pipeline/logs/20260324_125631_tester.meta.json`
- `.opencode/pipeline/logs/20260324_125631_validator.log`
- `.opencode/pipeline/logs/20260324_125631_validator.meta.json`
- `.opencode/pipeline/reports/20260324_125631.md`
- `pipeline-plan.json`
- `tasks/restore-foundry-tui-monitor--foundry/artifacts`
- `tasks/restore-foundry-tui-monitor--foundry/artifacts/checkpoint.json`
- `tasks/restore-foundry-tui-monitor--foundry/artifacts/telemetry`
- `tasks/restore-foundry-tui-monitor--foundry/artifacts/telemetry/coder.json`
- `tasks/restore-foundry-tui-monitor--foundry/artifacts/telemetry/planner.json`
- `tasks/restore-foundry-tui-monitor--foundry/artifacts/telemetry/tester.json`
- `tasks/restore-foundry-tui-monitor--foundry/artifacts/telemetry/validator.json`
- `tasks/restore-foundry-tui-monitor--foundry/summary.md`

### validator
- `.opencode/pipeline/handoff.md`

## Агенти
### planner
- Що зробив: визначив профіль `quick-fix`, звузив scope до workspace-path cleanup, зібрав початковий список файлів зі застарілими `agents/` посиланнями.
- Які були складнощі або блокери: блокерів не було; виявив, що `agents/` ще існує як набір порожніх stub-директорій, тому потрібно було відрізняти реальні файлові шляхи від API та prose-згадок.
- Що залишилось виправити або доробити: у межах планування нічого; результати передані coder.

### coder
- Що зробив: оновив path references у bootstrap-скриптах, `Makefile`, `scripts/validate-deployment-config.sh`, `scripts/external-agent.sh`, а також у `.opencode/skills/architect/SKILL.md`, `.opencode/skills/coder/SKILL.md`, `.opencode/skills/translater/SKILL.md`, `.opencode/skills/validator/SKILL.md`.
- Які були складнощі або блокери: блокерів не було; довелося відфільтрувати валідні згадки на кшталт `/api/v1/internal/agents/` і документаційні згадки, які не є filesystem path.
- Що залишилось виправити або доробити: локальні synced copies у `.cursor/skills/` та source-файли у `brama-core/skills/` ще не синхронізовані з цими змінами.

### validator
- Що зробив: перевірив handoff і scope змін, підтвердив, що змінені лише workspace/root файли, тому app-level PHPStan і CS перевірки не запускались поза scope; оновив секцію Validator у handoff.
- Які були складнощі або блокери: блокерів не було.
- Що залишилось виправити або доробити: якщо надалі змінюватимуться `brama-core` або `brama-agents/*`, тоді потрібно окремо прогнати відповідні app-level перевірки.

## Що треба доробити
- Синхронізувати зміни зі source-of-truth у `brama-core/skills/` і розповсюдити їх у локальні копії через `make sync-skills`.
- Окремо вирішити долю порожніх stub-директорій у `agents/`, щоб вони не вводили в оману інструменти та людей.

## Пропозиція до наступної задачі
- Назва задачі: Синхронізувати оновлені skill paths з `brama-core/skills/` у всі agent-local копії
- Чому її варто створити зараз: поточний пайплайн виправив `.opencode/skills/`, але source-of-truth і synced copies ще можуть містити старі `agents/` шляхи, що знову розсинхронізує підказки для агентів.
- Очікуваний результат: `brama-core/skills/` оновлено до `brama-agents/`, виконано `make sync-skills`, а `.cursor/skills/`, `.codex/skills/` та інші локальні копії більше не містять stale path references.

---

## Вартість пайплайну

| Агент | Тривалість | Input | Output | Cache Read | Cache Write | ≈ Вартість |
|-------|-----------|-------|--------|------------|-------------|-----------|
| coder | 6m 41s | 65 | 17724 | 3407779 | 85720 | $1.610 |
| validator | 43s | 18320 | 930 | 98944 | 0 | $0.099 |
| summarizer | 2m 11s | 49200 | 5062 | 316544 | 0 | $0.318 |
| **Всього** | **9m** | **67585** | **23716** | **3823267** | **85720** | **$2.027** |

_Вартість розрахована приблизно за тарифами Claude Sonnet ($3/$15 per 1M in/out, $0.30/$3.75 cache r/w)._
