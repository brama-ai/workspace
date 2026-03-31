# Tasks: Improve summary.md Structure

**Change ID:** `improve-summary-md-structure`

## Phase 1: Update Format Specification

- [ ] **1.1** Update `SKILL.md` section order
  - Change `Output Contract` → `Required section order` to the new 15-section order
  - Update the markdown template at the top of SKILL.md to match
  - Add `## Files Changed By Agent` section template with per-agent format
  - **Verify:** SKILL.md is internally consistent (template matches Output Contract)
  - **Impl:** `.opencode/skills/summarizer/SKILL.md`

## Phase 2: Telemetry Tooling

- [ ] **2.1** Add `Files Changed By Agent` emission to `render-summary.ts`
  - Read file change data from telemetry JSON (`filesChanged` / `filesWritten` arrays)
  - Emit `## Files Changed By Agent` section with per-agent subsections
  - Mark each file as `(created)` or `(modified)` where data allows
  - Fall back to `- none recorded` per agent when data is unavailable
  - **Verify:** unit test with mock telemetry JSON containing file changes
  - **Impl:** `agentic-development/monitor/src/cli/render-summary.ts`

- [ ] **2.2** Update `cost-tracker.sh summary-block` to include Files Changed
  - Add `## Files Changed By Agent` output between `## Tools By Agent` and `## Files Read By Agent`
  - Source data from the same telemetry path as render-summary.ts
  - **Verify:** run `cost-tracker.sh summary-block` on an archived task and confirm new section appears
  - **Impl:** `agentic-development/lib/cost-tracker.sh`

## Phase 3: Normalizer Compatibility

- [ ] **3.1** Update `normalize-summary.ts` to handle both old and new section order
  - Ensure section extraction is header-based, not position-based
  - Add extraction for `## Files Changed By Agent` section
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
