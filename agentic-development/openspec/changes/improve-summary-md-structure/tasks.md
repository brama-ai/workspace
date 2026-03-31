# Tasks: Improve summary.md Structure

**Change ID:** `improve-summary-md-structure`

## Phase 1: Update Format Specification

- [x] **1.1** Update `SKILL.md` section order
  - Change `Output Contract` → `Required section order` to the new 16-position order (actionable first, telemetry last)
  - Update the markdown template at the top of SKILL.md to match the new order
  - Add `## Files Changed By Agent` section template with per-agent format
  - Move `## Труднощі`, `## Незавершене`, `## Рекомендації по оптимізації`, `## Наступна задача`, `## Рекомендовані задачі` before telemetry sections
  - Update `Required Commands` section: replace `cost-tracker.sh` references with `render-summary.ts` (the bash script was deleted in the TS migration)
  - **Verify:** SKILL.md is internally consistent (template matches Output Contract)
  - **Impl:** `.opencode/skills/summarizer/SKILL.md`

## Phase 2: Telemetry Tooling

- [x] **2.1** Add `Files Changed By Agent` emission to `render-summary.ts`
  - Add `extractFilesChanged(data: SessionExport): string[]` function that detects `write` and `edit` tool calls with `filePath` parameter
  - Add `files_changed: string[]` field to `AgentRow` interface
  - Call `extractFilesChanged` in `buildAgentRow` and populate the field
  - In `renderFoundry`, read `files_changed` from telemetry JSON records (field `files_changed`)
  - In `renderTable`, emit `## Files Changed By Agent` section between `## Tool Usage By Agent` and `## Files Read By Agent`
  - Each agent subsection lists files as `- \`path\` (created)` or `- \`path\` (modified)`, or `- none recorded` if empty
  - Exclude files changed by `u-summarizer` (summary.md, result.json)
  - **Verify:** unit test with mock telemetry JSON containing file changes; unit test with session export containing write/edit tool calls
  - **Impl:** `agentic-development/monitor/src/cli/render-summary.ts`

- [x] **2.2** Update `TelemetryRecord` to include `files_changed`
  - Add `files_changed?: string[]` to `TelemetryRecord` interface in `telemetry.ts`
  - Update `writeTelemetryRecord` to accept and persist `files_changed`
  - **Verify:** existing telemetry tests still pass
  - **Impl:** `agentic-development/monitor/src/state/telemetry.ts`

## Phase 3: Normalizer Compatibility

- [x] **3.1** Update `normalize-summary.ts` to handle both old and new section order
  - Ensure section extraction is header-based, not position-based (already mostly true via `extractSection`)
  - Update the `render` function to emit sections in v2 order: Що зроблено → Труднощі → Незавершене → Наступна задача → telemetry block
  - Add extraction for `## Files Changed By Agent` section (pass through from telemetry block)
  - **Verify:** unit test parses both old-format and new-format summary.md correctly
  - **Impl:** `agentic-development/monitor/src/lib/normalize-summary.ts` + tests

## Phase 4: Validation

- [ ] **4.1** Generate a test summary with the new format
  - Run a Foundry task and verify `summary.md` follows the new section order
  - Confirm `Files Changed By Agent` section appears with agent file data
  - Confirm actionable sections (Труднощі, Незавершене, Рекомендації) are before telemetry
  - **Verify:** manual review of generated summary.md

- [ ] **4.2** Verify monitor TUI still renders summaries correctly
  - Confirm `normalize-summary.ts` extracts status, difficulties, unfinished items from new-format summaries
  - Confirm old archived summaries still parse correctly
  - **Verify:** run `foundry monitor` and check summary panel for both old and new format tasks
