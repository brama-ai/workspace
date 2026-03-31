# Spec: summary.md Format v2

**Change ID:** `improve-summary-md-structure`
**Spec:** `summary-format`

## Overview

Defines the new section order for `summary.md` and the new `Files Changed By Agent` section.

## Section Order (authoritative)

```markdown
# Model Alert
← optional, only when model-alerts.md exists; always first

# <Назва задачі>
**Статус:** PASS | FAIL
**Workflow:** Foundry | Ultraworks
**Профіль:** <profile name>
**Тривалість:** Xm Ys

## Що зроблено
- Стислі bullet points що саме реалізовано
- Файли створені/змінені (кількість)

## Труднощі
- Проблеми які виникли та як вирішені

## Незавершене
- Що лишилось зробити (якщо є)

## Рекомендації по оптимізації
> ОБОВ'ЯЗКОВА якщо виконується будь-яка anomaly detection rule. Інакше — не додавати.

### 🔴 [Anomaly type]: [brief description]
**Що сталось:** ...
**Вплив:** ...
**Рекомендація:** ...

## Наступна задача
Одна конкретна пропозиція що робити далі.

## Рекомендовані задачі
> Зібрані з `## Recommended follow-up tasks` у handoff.md — omit if none.
- **[Назва]** — [чому потрібно], зачіпає [файли/область]

---

## Telemetry
| Agent | Model | Input | Output | Price | Time |
|-------|-------|------:|-------:|------:|-----:|

## Моделі
| Model | Agents | Input | Output | Price |
|-------|--------|------:|-------:|------:|

## Token Burn & Cache Efficiency
| Model | Msgs | Avg Input | Avg Cache Read | Cache Hit % | Grade | Total Input | Total Cached |
|-------|-----:|----------:|---------------:|------------:|:-----:|------------:|-------------:|

## Tools By Agent
### <agent>
- `tool_name` x N

## Files Changed By Agent
### <agent>
- `path/to/file.ts` (created)
- `path/to/other.ts` (modified)

## Files Read By Agent
### <agent>
- `path/to/file.ts`

PIPELINE COMPLETE | PIPELINE INCOMPLETE
```

## New Section: Files Changed By Agent

### Purpose

Show which files each agent created or modified during the pipeline run. This complements the existing `Files Read By Agent` by showing agent output, not just input.

### Data Sources (checked in priority order)

1. **Telemetry JSON** — `artifacts/telemetry/<agent>.json`, fields `filesChanged` or `filesWritten`
2. **Agent result.json** — `artifacts/<agent>/result.json`, self-reported modified files
3. **Git diff** — diff between pre-agent and post-agent state (using checkpoint timestamps)

### Format Rules

- One subsection per agent that ran (same agents as in Telemetry table)
- Each file on its own line as inline code
- Annotate `(created)` for new files, `(modified)` for changed files
- If annotation data unavailable, list file without annotation
- If no file changes recorded for an agent: `- none recorded`
- Sort files alphabetically within each agent subsection
- Do NOT include files changed by `u-summarizer` itself (summary.md, result.json)

### Example

```markdown
## Files Changed By Agent
### u-architect
- none recorded

### u-coder
- `agentic-development/monitor/src/lib/model-inventory.ts` (created)
- `agentic-development/monitor/src/lib/model-routing.ts` (created)
- `agentic-development/monitor/src/__tests__/model-inventory.test.ts` (created)
- `agentic-development/monitor/src/__tests__/model-routing.test.ts` (created)
- `agentic-development/monitor/src/pipeline/runner.ts` (modified)

### u-auditor
- `agentic-development/monitor/src/__tests__/helpers/fixtures.ts` (modified)

### u-tester
- none recorded

### u-validator
- none recorded
```

## Section Order Rationale

| Position | Section | Why here |
|----------|---------|----------|
| 1 | Model Alert | Critical — must be seen first, operator may need to act before reading anything else |
| 2 | Title + metadata | Context: what task, did it pass, how long |
| 3 | Що зроблено | Quick: what was delivered |
| 4 | Труднощі | What went wrong — key for FAIL pipelines |
| 5 | Незавершене | What's left — key for planning next run |
| 6 | Рекомендації | How to fix anomalies — actionable |
| 7 | Наступна задача | One clear next step |
| 8 | Рекомендовані задачі | Backlog from agents — lower priority than next task |
| 9–14 | Telemetry block | Deep dive — only needed for cost analysis or debugging |
| 15 | PIPELINE marker | Machine-readable completion signal |

## Migration

- `normalize-summary.ts` must accept sections in any order (both v1 and v2)
- Old archived summaries are NOT migrated
- New summaries follow v2 order starting from the SKILL.md update
- The `---` separator between narrative and telemetry blocks is optional (visual aid only)

## Validation Criteria

- [ ] SKILL.md `Required section order` matches this spec exactly
- [ ] `render-summary.ts` emits `## Files Changed By Agent` section
- [ ] `cost-tracker.sh summary-block` emits `## Files Changed By Agent` section
- [ ] `normalize-summary.ts` parses both v1 and v2 summaries
- [ ] Generated summary.md has Труднощі before Telemetry
- [ ] Generated summary.md has Files Changed By Agent between Tools and Files Read
