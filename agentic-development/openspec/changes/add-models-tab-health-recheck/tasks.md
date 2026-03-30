# Tasks: Add Models Tab and Health Recheck to Foundry TUI

**Change ID:** `add-models-tab-health-recheck`

## Phase 1: Model Inventory and State

- [ ] **1.1** Add a model inventory module that collects active models from `.opencode/oh-my-opencode.jsonc`
  - Read `agents.*.model`, `agents.*.fallback_models[]`, `categories.*.model`, and `categories.*.fallback_models[]`
  - De-duplicate by model ID
  - Preserve references to which agents/categories use each model
  - **Verify:** unit test covers duplicate models, fallback-only models, and malformed optional sections

- [ ] **1.2** Refactor runner model resolution to use `.opencode/oh-my-opencode.jsonc`
  - Replace runner-local `DEFAULT_FALLBACKS` as the normal source for Foundry execution order
  - Resolve primary + fallback chain for each agent from the same config used by the Models tab
  - If an agent has no config entry, emit a visible warning and use random degraded fallback behavior
  - **Verify:** unit test covers `u-architect` and `u-coder` resolution from JSONC, proves runtime order matches config order, and covers missing-agent-config fallback behavior

- [ ] **1.3** Extend blacklist persistence helpers to support metadata
  - Keep compatibility with legacy entries containing only `model` and `expiresAt`
  - Support optional fields for `reasonCode`, `errorMessage`, `lastCheckedAt`, and `lastSuccessAt`
  - Add helper to remove a specific model from the blacklist safely
  - **Verify:** unit test covers legacy load, metadata load, add, update, and remove

## Phase 2: Model Probe / Recheck

- [ ] **2.1** Implement a dedicated single-model probe flow
  - Probe the exact selected model with fallback disabled
  - Use a minimal prompt and bounded timeout
  - Treat success as: provider responds successfully with non-empty completion and no quota/rate-limit failure
  - **Verify:** unit/integration test covers healthy response path

- [ ] **2.2** Classify probe failures into operator-readable categories
  - Categories: `quota_or_tokens`, `rate_limit`, `service_unavailable`, `timeout`, `provider_error`
  - Preserve raw provider error text when classification is unknown
  - **Verify:** unit test covers known error strings and unknown fallback behavior

- [ ] **2.3** Update blacklist state from probe results
  - Success removes the model from the blocking list and records `lastSuccessAt`
  - Failure keeps or creates the block entry and stores category + short error text
  - **Verify:** integration test covers success unblocking and failure blocking paths

## Phase 3: TUI Models Tab

- [ ] **3.1** Add tab `4:Models` to the monitor
  - Support direct navigation with key `4` and left/right cycling
  - Keep existing Tasks/Commands/Processes behavior unchanged
  - **Verify:** manual check in `foundry monitor` and unit coverage for tab state if available

- [ ] **3.2** Render active model rows in the Models tab
  - Show model ID, source usage summary, and status icon
  - Green check for active models not currently blocked
  - Red cross for models currently blacklisted
  - **Verify:** UI test or component-level render assertions for mixed states

- [ ] **3.3** Render inline error detail under affected models
  - When a model has latest failure metadata, show one short error line under that model
  - Prefer categorized copy (`quota/tokens`, `rate limit`, `service unavailable`, `timeout`)
  - If uncategorized, show the captured provider message
  - **Verify:** component-level render assertions for categorized and raw errors

- [ ] **3.4** Add recheck command for the selected model
  - Trigger via keyboard shortcut from the Models tab
  - Show progress/message bar feedback
  - Refresh the list after the probe completes
  - **Verify:** manual run in TUI confirms status changes without restart

## Phase 4: Documentation and Validation

- [ ] **4.1** Update operator documentation for the Models tab and recovery workflow
  - Document `.opencode/oh-my-opencode.jsonc` as the single source of truth for Foundry model routing
  - Document degraded random fallback behavior when an agent has no routing entry
  - Document status colors and recheck behavior
  - Document that successful recheck removes the model from the blacklist

- [ ] **4.2** Add/extend tests for the full workflow
  - Inventory parsing
  - Missing-agent-config warning and degraded fallback behavior
  - Blacklist metadata compatibility
  - Probe result classification
  - TUI state/render behavior for the Models tab

- [ ] **4.3** Update summary generation to surface model/config errors at the top of `summary.md`
  - Prepend latest model-related warning or error before the normal summary sections
  - Cover missing config, degraded random fallback, blacklist, and provider failure cases
  - **Verify:** test covers top-of-file model error rendering

- [ ] **4.4** Validate the OpenSpec change with `openspec validate add-models-tab-health-recheck --strict`
