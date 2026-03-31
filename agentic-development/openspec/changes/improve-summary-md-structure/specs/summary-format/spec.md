# Spec: summary.md Format v2

**Change ID:** `improve-summary-md-structure`
**Spec:** `summary-format`

## ADDED Requirements

### Requirement: Files Changed By Agent section

The summary.md output SHALL include a `## Files Changed By Agent` section that lists files each agent created or modified during the pipeline run. This section complements the existing `Files Read By Agent` by showing agent output, not just input.

Data sources (checked in priority order):
1. **Telemetry JSON** — `artifacts/telemetry/<agent>.json`, fields `filesChanged` or `filesWritten`
2. **Agent result.json** — `artifacts/<agent>/result.json`, self-reported modified files
3. **Git diff** — diff between pre-agent and post-agent state (using checkpoint timestamps)

Format rules:
- One subsection per agent that ran (same agents as in Telemetry table)
- Each file on its own line as inline code
- Annotate `(created)` for new files, `(modified)` for changed files
- If annotation data unavailable, list file without annotation
- If no file changes recorded for an agent: `- none recorded`
- Sort files alphabetically within each agent subsection
- Do NOT include files changed by `u-summarizer` itself (summary.md, result.json)

#### Scenario: Agent with file changes in telemetry JSON
- **WHEN** telemetry JSON for an agent contains a `filesChanged` or `filesWritten` array with entries
- **THEN** the `## Files Changed By Agent` section SHALL list each file under the agent's `### <agent>` subsection, annotated as `(created)` or `(modified)` where data allows, sorted alphabetically

#### Scenario: Agent with no file change data
- **WHEN** no file change data is available for an agent (no telemetry field, no result.json, no git diff)
- **THEN** the agent's subsection SHALL display `- none recorded`

#### Scenario: Summarizer agent files excluded
- **WHEN** `u-summarizer` creates or modifies files (summary.md, result.json)
- **THEN** those files SHALL NOT appear in the `Files Changed By Agent` section

#### Scenario: render-summary.ts emits Files Changed section
- **WHEN** `render-summary.ts` renders telemetry for a Foundry or Ultraworks session
- **THEN** the output SHALL include a `## Files Changed By Agent` section positioned between `## Tools By Agent` (or `## Tool Usage By Agent`) and `## Files Read By Agent`

#### Scenario: SKILL.md references render-summary.ts instead of deleted cost-tracker.sh
- **WHEN** the summarizer agent reads SKILL.md `Required Commands` section
- **THEN** the commands SHALL reference `render-summary.ts` (not the deleted `cost-tracker.sh`)

### Requirement: Files Changed data extraction in render-summary.ts

The `render-summary.ts` helper SHALL extract file change data from session exports by detecting `write` and `edit` tool calls (analogous to how `extractFilesRead` detects `read`, `grep`, `glob`, `edit` calls). The `AgentRow` interface SHALL include a `files_changed` field.

#### Scenario: Extract files from write and edit tool calls
- **WHEN** a session export contains tool calls of type `write` or `edit` with a `filePath` parameter
- **THEN** `extractFilesChanged` SHALL return a deduplicated, sorted list of those file paths

#### Scenario: Foundry telemetry JSON contains files_changed field
- **WHEN** a Foundry telemetry JSON record contains a `files_changed` array
- **THEN** `renderFoundry` SHALL populate the `files_changed` field on the `AgentRow` from that array

## MODIFIED Requirements

### Requirement: Summary section order

The summary.md output SHALL follow a new section order that places actionable content (difficulties, incomplete work, recommendations, next steps) before telemetry/diagnostic sections.

Previous order: Title, Metadata, Що зроблено, Telemetry, Моделі, Tools By Agent, Files Read By Agent, Труднощі, Незавершене, Рекомендації по оптимізації, Рекомендовані задачі, Наступна задача.

New authoritative order:

```
1.  # Model Alert                          (optional, only if alerts exist)
2.  # <Назва задачі> + metadata block      (Статус, Workflow, Профіль, Тривалість)
3.  ## Що зроблено                         (brief bullets: what was delivered)
4.  ## Труднощі                            (what went wrong, blockers)
5.  ## Незавершене                          (what's left to do)
6.  ## Рекомендації по оптимізації          (mandatory if anomalies detected)
7.  ## Наступна задача                      (one concrete next step)
8.  ## Рекомендовані задачі                 (follow-up proposals from agents, if any)
9.  ---                                     (optional visual separator)
10. ## Telemetry                            (per-agent table)
11. ## Моделі                              (per-model aggregate)
12. ## Token Burn & Cache Efficiency        (burn snapshots, cache hit rates)
13. ## Tools By Agent                       (tool call counts per agent)
14. ## Files Changed By Agent               (NEW: files created/modified per agent)
15. ## Files Read By Agent                  (files consumed as input per agent)
16. PIPELINE COMPLETE | PIPELINE INCOMPLETE (machine-readable marker)
```

#### Scenario: Actionable sections appear before telemetry
- **WHEN** a summary.md is generated
- **THEN** `## Труднощі`, `## Незавершене`, `## Рекомендації по оптимізації`, and `## Наступна задача` SHALL appear before `## Telemetry`

#### Scenario: Telemetry sections grouped at bottom
- **WHEN** a summary.md is generated
- **THEN** `## Telemetry`, `## Моделі`, `## Token Burn & Cache Efficiency`, `## Tools By Agent`, `## Files Changed By Agent`, and `## Files Read By Agent` SHALL appear as a contiguous block after all narrative/actionable sections

#### Scenario: SKILL.md reflects new section order
- **WHEN** the summarizer agent reads `.opencode/skills/summarizer/SKILL.md`
- **THEN** the `Required section order` list and the markdown template SHALL match the new 16-position order defined above

### Requirement: normalize-summary.ts backward compatibility

The `normalize-summary.ts` parser SHALL accept summary.md files in both the old section order (v1) and the new section order (v2), extracting sections by header name rather than by position.

#### Scenario: Parse new-format summary with actionable sections first
- **WHEN** `normalize-summary.ts` receives a summary.md where `## Труднощі` appears before `## Telemetry`
- **THEN** it SHALL correctly extract status, difficulties, unfinished items, and next task

#### Scenario: Parse old-format summary with telemetry before difficulties
- **WHEN** `normalize-summary.ts` receives a summary.md where `## Telemetry` appears before `## Труднощі`
- **THEN** it SHALL correctly extract status, difficulties, unfinished items, and next task (same behavior as before)

#### Scenario: Extract Files Changed By Agent section
- **WHEN** `normalize-summary.ts` receives a summary.md containing `## Files Changed By Agent`
- **THEN** it SHALL be able to extract that section content for display in the monitor TUI

### Requirement: normalize-summary.ts section ordering in output

The `normalize-summary.ts` render function SHALL emit sections in the new v2 order: actionable content first (Що зроблено, Труднощі, Незавершене, Наступна задача), then telemetry block.

#### Scenario: Normalized output follows v2 order
- **WHEN** `normalize-summary.ts` normalizes any summary.md (old or new format)
- **THEN** the output SHALL place `## Труднощі` and `## Незавершене` before the telemetry block, and `## Наступна задача` after `## Незавершене`

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
| 9-14 | Telemetry block | Deep dive — only needed for cost analysis or debugging |
| 15 | PIPELINE marker | Machine-readable completion signal |

## Migration

- `normalize-summary.ts` MUST accept sections in any order (both v1 and v2)
- Old archived summaries are NOT migrated
- New summaries follow v2 order starting from the SKILL.md update
- The `---` separator between narrative and telemetry blocks is optional (visual aid only)

## Files Changed By Agent — Example

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

## Validation Criteria

- [ ] SKILL.md `Required section order` matches this spec exactly
- [ ] `render-summary.ts` emits `## Files Changed By Agent` section
- [ ] `render-summary.ts` includes `extractFilesChanged` function and emits `## Files Changed By Agent`
- [ ] `normalize-summary.ts` parses both v1 and v2 summaries
- [ ] Generated summary.md has Труднощі before Telemetry
- [ ] Generated summary.md has Files Changed By Agent between Tools and Files Read
