# Spec: Model Health Recheck

**Capability:** `model-health-recheck`
**Parent Change:** `add-models-tab-health-recheck`

## ADDED Requirements

### Requirement: Manual recheck command for a selected model
The Foundry monitor SHALL provide a manual recheck command for the currently selected model in the Models tab.

The recheck MUST test the exact selected model with fallback disabled, using a lightweight provider request and a bounded timeout.

#### Scenario: Operator rechecks selected model
- **WHEN** the operator triggers the recheck command on a selected model in the Models tab
- **THEN** Foundry runs a dedicated health probe for that exact model
- **AND** the monitor refreshes the model row after the probe completes

### Requirement: Recheck targets the runtime-configured model namespace
Manual recheck SHALL operate on model IDs resolved from `.opencode/oh-my-opencode.jsonc`, which is also the runtime routing source for Foundry.

#### Scenario: Recheck uses model ID from routing config
- **WHEN** the operator selects a model shown in the Models tab
- **THEN** the recheck probes the exact model ID resolved from `.opencode/oh-my-opencode.jsonc`
- **AND** no separate runner-only alias or fallback ordering changes the targeted model

### Requirement: Summary surfaces model errors first
When Foundry encounters a model-routing or model-provider error, the generated `summary.md` SHALL render the latest model-related warning or error at the top of the file before the normal summary sections.

#### Scenario: Missing agent config appears at top of summary
- **WHEN** an agent has no routing entry and Foundry uses degraded random fallback behavior
- **THEN** `summary.md` starts with a visible warning describing the missing config and chosen degraded behavior

#### Scenario: Provider failure appears at top of summary
- **WHEN** a model fails because of blacklist, quota, rate limit, timeout, or provider error
- **THEN** `summary.md` starts with the latest model-related failure text before the regular summary headings

### Requirement: Successful recheck restores the model
If the health probe completes successfully, produces a non-empty response, and does not hit quota, token, or service-limit failures, Foundry SHALL treat the model as healthy.

When a healthy result is confirmed, Foundry SHALL remove that model from the blocking list and persist the successful probe timestamp.

#### Scenario: Blacklisted model recovers
- **WHEN** a previously blacklisted model succeeds during manual recheck
- **THEN** the model is removed from `.foundry-blacklist.json`
- **AND** the Models tab updates the row to a green check

### Requirement: Failed recheck keeps or creates a blocking entry
If the health probe fails, Foundry SHALL keep the model blacklisted or add it to the blacklist if it was not already blocked.

The stored probe result SHALL capture a categorized reason code and a short error message suitable for operator display.

#### Scenario: Recheck fails because of quota or token limits
- **WHEN** the provider responds with a quota, billing, or token-limit failure during recheck
- **THEN** the model remains blocked
- **AND** the stored reason code is `quota_or_tokens`
- **AND** the UI shows a short quota/tokens error under the model

#### Scenario: Recheck fails because the provider is unavailable
- **WHEN** the provider responds with rate-limit, service-unavailable, or timeout failure during recheck
- **THEN** the model remains blocked
- **AND** the stored reason code is `rate_limit`, `service_unavailable`, or `timeout` as appropriate

#### Scenario: Recheck fails with unknown provider error
- **WHEN** the provider fails with an error that does not match a known category
- **THEN** the model remains blocked
- **AND** the stored reason code is `provider_error`
- **AND** the UI shows the raw provider error message under the model

### Requirement: Backwards-compatible blacklist metadata
Foundry SHALL preserve compatibility with the existing blacklist file while supporting optional metadata fields needed for the Models tab.

Blacklist entries MAY include `reasonCode`, `errorMessage`, `lastCheckedAt`, and `lastSuccessAt` in addition to existing fields.

#### Scenario: Load legacy blacklist entry
- **WHEN** Foundry loads a blacklist entry containing only `model` and `expiresAt`
- **THEN** the entry is still treated as blocked
- **AND** Foundry does not fail due to missing metadata fields

#### Scenario: Persist metadata after failed recheck
- **WHEN** a failed recheck updates a blacklist entry
- **THEN** the entry is written back with the blocking status preserved
- **AND** includes the latest available error metadata for the UI
