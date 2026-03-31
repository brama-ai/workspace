# Design: Improve summary.md Structure

## Problem

Operators reviewing pipeline results must scroll past telemetry tables to find actionable information (difficulties, incomplete work, recommendations). Files modified by agents are not surfaced — only files read.

## Goals

- Actionable sections (Труднощі, Незавершене, Рекомендації, Наступна задача) appear immediately after the brief "what was done" narrative
- All telemetry/diagnostic sections are grouped together at the bottom
- Each agent's file changes (create/modify) are visible in a dedicated section
- Backward-compatible: `normalize-summary.ts` handles both old and new section order during transition

## Non-Goals

- Changing the content or format of individual telemetry tables
- Changing how telemetry data is collected
- Migrating existing archived summaries to the new format

## Decisions

### 1. Section order: narrative first, telemetry last

The new order groups content by audience need:

**Quick review block** (top) — what the operator needs to act on:
1. Model Alert (if any)
2. Title + metadata
3. Що зроблено (brief)
4. Труднощі
5. Незавершене
6. Рекомендації по оптимізації
7. Наступна задача
8. Рекомендовані задачі

**Deep dive block** (bottom) — for debugging and cost analysis:
9. Telemetry (agent table)
10. Моделі (model aggregate)
11. Token Burn & Cache Efficiency
12. Tools By Agent
13. Files Changed By Agent
14. Files Read By Agent
15. PIPELINE COMPLETE / INCOMPLETE marker

Rationale: most summary reviews are "did it pass? what broke? what's next?" — that takes 10 seconds with the new order vs scrolling through 50+ lines of tables first.

### 2. Files Changed By Agent — data source

Agent file changes come from two sources, checked in order:

1. **Telemetry JSON** (`artifacts/telemetry/<agent>.json`) — if it contains a `filesChanged` or `filesWritten` array
2. **Git diff per agent** — parse `git diff` between the commit before the agent started and after it completed (using checkpoint timestamps or handoff markers)
3. **Agent result.json** — some agents self-report modified files in their `result.json` artifact

The `render-summary.ts` helper will emit this section alongside the existing `Files Read By Agent`. Format:

```markdown
## Files Changed By Agent
### u-coder
- `src/lib/model-routing.ts` (modified)
- `src/lib/model-inventory.ts` (created)
- `src/__tests__/model-routing.test.ts` (created)

### u-auditor
- `src/__tests__/helpers/fixtures.ts` (modified)
```

If no file change data is available for an agent, print `- none recorded`.

### 3. Backward compatibility in normalize-summary.ts

The normalizer already uses regex-based section extraction. It will:
- Accept sections in any order (both old and new)
- Key on section headers (`## Труднощі`, `## Telemetry`, etc.) not on position
- The `status` and `difficulties` extractors remain unchanged

### 4. SKILL.md is the authoritative format definition

The summarizer agent reads `SKILL.md` to know the section order. Updating `SKILL.md` is sufficient to change the output format — no prompt changes needed in `u-summarizer.md` beyond what SKILL.md already provides.

### 5. render-summary.ts changes (replaces cost-tracker.sh)

The legacy `cost-tracker.sh` was deleted during the full TS migration (commit `24cd842`). Its `summary-block` functionality now lives in `render-summary.ts`.

The `renderTable` function currently emits: Telemetry → Token Burn → Tool Usage By Agent → Files Read By Agent.

It will be extended to also emit `## Files Changed By Agent` between Tool Usage and Files Read. A new `extractFilesChanged` function will detect `write` and `edit` tool calls from session exports (analogous to `extractFilesRead`). For Foundry mode, the `files_changed` field from telemetry JSON records will be used directly.

## Data Flow

1. Pipeline runs agents, each producing telemetry JSON + result.json
2. `render-summary.ts` reads telemetry, emits all telemetry sections including new `Files Changed By Agent`
3. `u-summarizer` reads handoff.md + telemetry output, writes `summary.md` with new section order per SKILL.md
4. `normalize-summary.ts` parses the summary for monitor display — extracts sections by header regardless of order

## Risks and Trade-offs

- Agents using old SKILL.md cache may produce old-order summaries — mitigated by normalize-summary.ts accepting any order
- `Files Changed By Agent` may be empty if telemetry doesn't capture write operations — acceptable, shows `none recorded`
- Reordering breaks visual muscle memory for operators used to old format — mitigated by clear section headers and the fact that actionable info is now easier to find
