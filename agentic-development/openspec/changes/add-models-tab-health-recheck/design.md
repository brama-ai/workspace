# Design: Models Tab and Health Recheck for Foundry

## Problem

Foundry already knows how to blacklist failing models, but operators cannot see active model inventory or recover a model from the TUI. The existing blacklist file also stores too little information to explain why a model is blocked.

## Goals

- Show every active model referenced by current Foundry routing config
- Let operators see whether each model is blocked right now
- Let operators recheck a selected model from the TUI
- Remove a model from the blacklist immediately after a healthy probe
- Persist enough failure metadata to explain why a model is blocked

## Non-Goals

- Automatic retry loops for every model
- Automatic strategy tuning or fallback reordering
- Deep historical observability UI

## Decisions

### 1. Use one authoritative routing source

Foundry runtime model routing and the Models tab inventory will both use `.opencode/oh-my-opencode.jsonc` as the single source of truth.

The inventory will be built from these keys in `.opencode/oh-my-opencode.jsonc`:

1. `agents.*.model`
2. `agents.*.fallback_models[]`
3. `categories.*.model`
4. `categories.*.fallback_models[]`

Rows are de-duplicated by model ID and annotated with all agents/categories that reference the model. This keeps the UI operator-focused: one row per active model, not one row per config occurrence.

The runner must stop treating `DEFAULT_FALLBACKS` as authoritative configuration. Hardcoded fallback arrays may remain only as an emergency bootstrap fallback if config loading fails, but the normal execution path must resolve models from `.opencode/oh-my-opencode.jsonc`.

Agent markdown frontmatter such as `.opencode/agents/u-architect.md` may continue to declare a model for OpenCode agent metadata, but Foundry runtime selection must not derive its active execution order from those files.

If no explicit routing entry exists for an agent, Foundry must mark the condition as degraded configuration state. In that case the runner may pick a random available model only to preserve execution continuity, but it must emit a visible warning event and preserve that warning for summary output.

### 2. Keep the existing blacklist file, but allow metadata

The existing `.foundry-blacklist.json` file remains the source of truth for whether a model is blocked. To support the new UI, blacklist entries may include optional metadata fields:

- `reasonCode`
- `errorMessage`
- `lastCheckedAt`
- `lastSuccessAt`

Legacy entries that only contain `model` and `expiresAt` remain valid. Loader code must accept both shapes.

This is lower risk than introducing a second state file and avoids split-brain status between "blocked" and "last health result".

### 3. Recheck uses a dedicated exact-model probe

The recheck action must not reuse normal pipeline fallback behavior because that would hide whether the chosen model itself recovered. The probe path must:

- target exactly one model
- disable fallbacks
- use a short, deterministic prompt
- apply a bounded timeout
- treat zero-output responses as failure

The probe should go through the same provider/runtime surface as Foundry model execution so that it validates real operator recovery, not just config syntax.

### 4. Error classification is shallow but explicit

Operators need actionable status, not raw stack traces. The probe layer classifies failures into a small fixed set:

- `quota_or_tokens`
- `rate_limit`
- `service_unavailable`
- `timeout`
- `provider_error`

If no known classifier matches, the TUI displays the provider's raw error message. This preserves debuggability without overfitting to every provider string.

### 5. TUI stays table-first

The new tab follows the existing monitor style: a compact list with keyboard navigation and a footer hint. The selected row can be rechecked via one shortcut, and models with failure metadata render one extra detail line below the main row.

### 6. Summary shows model failures first

Model-routing and provider failures are currently easy to miss in long task summaries. The summary generation path should therefore surface the latest model-related warning or error before the regular `##` sections.

This top-of-file block should cover cases such as:

- selected model is blacklisted
- provider returned quota or rate-limit failure
- no `.opencode/oh-my-opencode.jsonc` routing entry exists for the agent
- degraded random fallback mode was used

## Data Flow

1. Load routing config from `.opencode/oh-my-opencode.jsonc`
2. Resolve the agent runtime model order from that config
3. If the agent has no routing entry, emit a degraded configuration warning and choose a random available model as last-resort fallback
4. Build the deduplicated inventory from the same loaded config
5. Load blacklist entries from `.foundry-blacklist.json`
6. Join both datasets by model ID
7. Render rows:
   - green check if model is active and not blacklisted
   - red cross if model is blacklisted
   - error detail line when metadata contains failure context
8. On recheck:
   - run exact-model probe
   - on success: remove blacklist entry, persist success timestamp, refresh UI
   - on failure: update blacklist entry with categorized error, refresh UI
9. On summary render:
   - prepend the latest model/config error block before the normal summary sections

## Risks and Trade-offs

- Extending the blacklist file couples health metadata to blocking state, but keeps recovery logic simple and observable
- Moving runtime selection to one config source removes drift, but requires a small refactor in the runner and config parsing path
- Allowing random fallback for missing config preserves continuity, but must stay visibly degraded so operators fix the config instead of normalizing the fallback
- Exact-model probe adds one more provider call path, but avoids false green results caused by fallbacks
- TUI row detail lines make the tab slightly denser, but satisfy the requirement to show the error under the model

## Verification Plan

- Unit tests for `.opencode/oh-my-opencode.jsonc` parsing and runner resolution compatibility
- Unit tests for missing-agent-config degraded fallback and warning propagation
- Unit tests for error classification
- Integration tests for recheck success/failure state updates
- Manual TUI validation for tab navigation, status icons, and inline error rendering
