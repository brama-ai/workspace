# Add Models Tab and Health Recheck to Foundry TUI

**Change ID:** `add-models-tab-health-recheck`
**Status:** approved
**Created:** 2026-03-30
**Author:** OpenCode

## Summary

Add a `Models` tab to the Foundry TUI that shows every active model currently referenced by Foundry agent routing, marks whether the model is currently blocked by the existing blacklist, and lets the operator recheck a specific model. A successful recheck clears the model from the blacklist; a failed recheck keeps or adds the block entry and shows the exact categorized error under the model row. As part of this change, Foundry runtime model selection must use `.opencode/oh-my-opencode.jsonc` as the single source of truth for primaries and fallbacks instead of maintaining a separate fallback map in the runner.

If an agent has no explicit model routing entry in `.opencode/oh-my-opencode.jsonc`, Foundry must surface that condition as an operator-visible configuration warning and may fall back to a random available model only as an explicit degraded-mode behavior. When model selection or probing fails, the final task summary must show the model error at the very beginning of `summary.md` so the failure is immediately visible.

## Motivation

### Problem

Foundry already has model fallback chains and a persisted blacklist, but operators do not have a single place to answer these basic questions:

1. Which models are actually active right now across agent configs and fallbacks?
2. Which of those models are currently blocked by the blacklist?
3. Why is a blocked model blocked?
4. Has the provider recovered, and can the model be safely returned to rotation?

Today that information is fragmented across `.opencode/oh-my-opencode.jsonc`, runner-local fallback defaults, agent prompt frontmatter, runtime logs, and `.foundry-blacklist.json`. This makes recovery slow and manual, and can cause the actual runtime model order to diverge from the operator-visible config.

### Why Now

- Foundry already has a TypeScript TUI in `monitor/src/components/App.tsx`
- Foundry already persists blacklist state in `monitor/src/agents/executor.ts`
- Operators need a direct recovery workflow instead of manually deleting blacklist files
- The requested behavior fits the existing monitor UX and makes model fallback operations observable

## Scope

### In Scope

- New `Models` tab in the Foundry TUI
- Active model inventory built from current agent routing config and fallbacks
- Migration of Foundry runner model/fallback resolution to `.opencode/oh-my-opencode.jsonc` as the single source of truth
- Status indicator per model: healthy/available vs blacklisted/unavailable
- Inline error details for blocked or failed models
- Manual recheck command for the selected model
- Success path that removes the model from the blocking list
- Failure path that keeps or creates a blocking entry with categorized error metadata
- Missing-agent-config warning with degraded random-model fallback behavior
- Summary output that prints model-related failure text at the top of `summary.md`

### Out of Scope

- Automatic scheduled rechecks of all models
- Rebalancing fallback order automatically
- Editing model routing from the TUI
- Historical analytics beyond latest known status/error
- Silent fallback to an unspecified model without surfacing a warning

## Impact

| Component | Impact |
|-----------|--------|
| `monitor/src/components/App.tsx` | **MODIFIED** — add Models tab, navigation, footer hints, recheck UX |
| `monitor/src/agents/executor.ts` | **MODIFIED** — expose blacklist metadata helpers and unblock support |
| `monitor/src/...` model inventory/state modules | **NEW/MODIFIED** — parse active models, run single-model probe, persist latest result |
| `.opencode/oh-my-opencode.jsonc` | **READ / AUTHORITATIVE** — single source of active models and fallback chains |
| `monitor/src/pipeline/runner.ts` | **MODIFIED** — remove or bypass hardcoded fallback defaults in favor of config-driven resolution |
| `.opencode/agents/*.md` | **READ ONLY FOR AGENT PROMPTS** — no longer authoritative for Foundry runtime model selection |
| `monitor/src/cli/render-summary.ts` and summary generation path | **MODIFIED** — move model error text to the top of `summary.md` |
| `.foundry-blacklist.json` | **MODIFIED** — preserve blocking metadata needed by the TUI |
| `agentic-development/README.md` and/or operator docs | **MODIFIED** — document Models tab and recovery workflow |

## Constraints

- Recheck MUST test the exact selected model, not a fallback chain
- Recheck MUST use a lightweight prompt and bounded timeout so the monitor stays responsive
- Existing blacklist file path and backwards compatibility MUST be preserved
- Error output shown in the UI MUST be short, operator-readable, and derived from the real provider failure
- The monitor MUST continue working even if config parsing fails or the blacklist file contains legacy entries
- Foundry runner and Models tab MUST resolve active models from the same configuration source so the UI matches actual execution order
- If an agent has no routing entry, Foundry MUST emit a visible warning before using degraded random-model fallback behavior
- `summary.md` MUST surface the latest model-related failure text before the normal summary sections

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Recheck accidentally tests a fallback instead of the selected model | Medium | Use a dedicated single-model probe path with fallback disabled |
| Runtime keeps using runner-local fallbacks that differ from the TUI source | High | Make `.opencode/oh-my-opencode.jsonc` the only authoritative source for primary and fallback resolution |
| Missing agent config silently hides routing mistakes | High | Emit explicit warning and record degraded random fallback in summary/logs |
| Legacy blacklist entries do not contain enough metadata for inline errors | High | Support optional metadata and show a safe fallback message when missing |
| TUI becomes crowded with another tab | Low | Keep one compact table and a single error line under affected rows |
| Provider errors are hard to normalize | Medium | Store a categorized reason plus raw provider message when classification is unknown |
