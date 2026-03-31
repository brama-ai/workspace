# Improve summary.md Section Order and Add Files Changed

**Change ID:** `improve-summary-md-structure`
**Status:** draft
**Created:** 2026-03-31
**Author:** Human

## Summary

Restructure `summary.md` to put actionable information first (alerts, difficulties, incomplete items, recommendations, next steps) and push telemetry/diagnostics to the bottom. Add a new `## Files Changed By Agent` section that lists files each agent created or modified — not just files read.

## Motivation

### Problem

The current summary format leads with `## Що зроблено` and telemetry tables, then buries `## Труднощі`, `## Незавершене`, and `## Рекомендації по оптимізації` deep in the document. When reviewing pipeline results, the operator must scroll past token tables and tool counts to find what actually matters: what went wrong, what's left, and what to do next.

Additionally, the current `## Files Read By Agent` only shows which files an agent consumed as input. There is no section showing which files the agent actually created or modified. This makes it hard to understand the real output of each agent without digging into git diffs.

### Why Now

- Summary is the primary artifact operators review after each pipeline run
- As pipelines grow longer (5–7 agents), telemetry sections push actionable content further down
- `Files Changed By Agent` data is already available in telemetry JSON and agent result artifacts — it just isn't surfaced

## Scope

### In Scope

- Reorder summary.md sections: actionable content first, telemetry second
- Add `## Files Changed By Agent` section (files created/modified per agent)
- Update SKILL.md (summarizer skill) with new section order
- Update `normalize-summary.ts` to parse the new structure
- Update `render-summary.ts` / `cost-tracker.sh` to emit `Files Changed By Agent` block

### Out of Scope

- Changing telemetry data collection itself
- Changing the monitor TUI summary rendering
- Changing how `model-alerts.md` is generated
- Historical summary migration (old summaries keep their format)

## Proposed Section Order

```markdown
# Model Alert                          ← only if alerts exist, always first
# <Назва задачі>                       ← build name / title
**Статус:** PASS | FAIL
**Workflow:** Foundry | Ultraworks
**Профіль:** <profile>
**Тривалість:** Xm Ys

## Що зроблено                         ← brief bullets: what was delivered
## Труднощі                            ← what went wrong, blockers
## Незавершене                          ← what's left to do
## Рекомендації по оптимізації          ← mandatory if anomalies detected
## Наступна задача                      ← one concrete next step
## Рекомендовані задачі                 ← follow-up proposals from agents (if any)

--- telemetry below ---

## Telemetry                            ← per-agent table (Model, Input, Output, Price, Time)
## Моделі                              ← per-model aggregate
## Token Burn & Cache Efficiency        ← burn snapshots, cache hit rates
## Tools By Agent                       ← tool call counts per agent
## Files Changed By Agent               ← NEW: files created/modified per agent
## Files Read By Agent                  ← files consumed as input per agent

PIPELINE COMPLETE | PIPELINE INCOMPLETE
```

## Key Changes vs Current

| # | What | Before | After |
|---|------|--------|-------|
| 1 | Section order | Що зроблено → Telemetry → Моделі → Tools → Files Read → Труднощі → Незавершене → Рекомендації → Наступна задача | Що зроблено → Труднощі → Незавершене → Рекомендації → Наступна задача → Рекомендовані задачі → [telemetry block] |
| 2 | Files Changed | Not present | New section listing created/modified files per agent |
| 3 | Telemetry position | Mixed with narrative (sections 4–7 of 12) | Grouped at bottom (sections 9–14) |
| 4 | Actionable info | Buried at sections 8–12 | Promoted to sections 3–6 |
