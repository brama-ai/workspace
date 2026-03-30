# Spec: Models Tab

**Capability:** `models-tab`
**Parent Change:** `add-models-tab-health-recheck`

## ADDED Requirements

### Requirement: Models tab in Foundry monitor
The Foundry monitor SHALL provide a fourth top-level tab named `Models` that displays the active model inventory used by Foundry routing.

#### Scenario: Navigate directly to Models tab
- **WHEN** the operator presses `4` in the monitor
- **THEN** the monitor switches to the `Models` tab
- **AND** the existing tabs remain available as `1:Tasks`, `2:Commands`, `3:Processes`

#### Scenario: Cycle into Models tab with arrow navigation
- **WHEN** the operator cycles through top-level tabs with left/right navigation
- **THEN** the Models tab participates in the same tab order as the existing tabs

### Requirement: Active model inventory
The Models tab SHALL list every active model currently referenced by Foundry configuration. The inventory MUST be derived from `.opencode/oh-my-opencode.jsonc`, including model IDs declared directly there and fallback model IDs declared there.

The inventory SHALL de-duplicate repeated model IDs and SHALL preserve a usage summary showing which agents or categories reference each model.

#### Scenario: Model appears only as a fallback
- **WHEN** a model is referenced only inside `fallback_models`
- **THEN** the model still appears in the Models tab inventory

#### Scenario: Same model appears in multiple sources
- **WHEN** the same model ID is referenced by multiple agents or categories in `.opencode/oh-my-opencode.jsonc`
- **THEN** the Models tab shows one row for that model
- **AND** the row includes a usage summary covering all known references

### Requirement: Models tab matches runner routing source
The Models tab SHALL use the same routing source as Foundry runtime model selection so that the operator-visible model list matches actual execution order.

#### Scenario: Runner and Models tab resolve the same architect models
- **WHEN** Foundry resolves the model chain for `u-architect`
- **THEN** the runtime chain and the Models tab inventory are both derived from `.opencode/oh-my-opencode.jsonc`
- **AND** the monitor does not rely on a different hardcoded fallback order for the same agent

#### Scenario: Agent has no routing entry
- **WHEN** Foundry needs to resolve models for an agent that has no explicit entry in `.opencode/oh-my-opencode.jsonc`
- **THEN** Foundry emits an operator-visible configuration warning
- **AND** the runtime may choose a random available model only as degraded fallback behavior
- **AND** the warning is preserved for operator-visible reporting

### Requirement: Model status indicators and inline error detail
Each model row in the Models tab SHALL show a status indicator derived from the current blacklist state.

- A green check SHALL indicate that the model is active and not currently blacklisted.
- A red cross SHALL indicate that the model is currently blacklisted.

If the latest known blacklist metadata contains failure details, the Models tab SHALL render one short error line directly under that model row.

#### Scenario: Healthy model row
- **WHEN** a listed model does not have an active blacklist entry
- **THEN** its row shows a green check
- **AND** no error line is shown unless a newer failure state exists

#### Scenario: Blacklisted model row
- **WHEN** a listed model has an active blacklist entry
- **THEN** its row shows a red cross
- **AND** the row shows the latest available failure detail under the model

#### Scenario: Legacy blacklist entry without metadata
- **WHEN** a model is blacklisted by a legacy entry that does not include error metadata
- **THEN** the Models tab still shows the red cross
- **AND** the inline detail falls back to a generic blocked message instead of failing to render
