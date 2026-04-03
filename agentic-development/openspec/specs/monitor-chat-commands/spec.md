# monitor-chat-commands Specification

## Purpose
Define the slash-command UX for the Foundry sidebar chat, including `/new`, `/compact`, and `/model` behavior.
## Requirements
### Requirement: Slash command suggestions in sidebar input
The Foundry sidebar chat SHALL show available slash commands when the operator types `/`.

The suggestion list SHALL filter as the typed command prefix becomes more specific.

#### Scenario: Suggestions appear on slash
- **WHEN** the operator types `/` in the sidebar input
- **THEN** the monitor shows the available slash commands

#### Scenario: Suggestions filter by prefix
- **WHEN** the operator types `/mo`
- **THEN** the suggestion list narrows to matching commands such as `/model`

### Requirement: New chat command
The sidebar chat SHALL support `/new` to start a fresh chat history.

#### Scenario: Operator starts a new chat
- **WHEN** the operator runs `/new`
- **THEN** Foundry creates a new active chat session
- **AND** the previous session remains stored as historical state rather than being silently overwritten

### Requirement: Compact command
The sidebar chat SHALL support `/compact` to manually compress the current chat history into compact memory.

Compaction SHALL preserve the same chat session identity.

#### Scenario: Operator manually compacts
- **WHEN** the operator runs `/compact`
- **THEN** Foundry compresses the current chat history into a compact memory summary
- **AND** the active chat session id remains unchanged
- **AND** the sidebar header updates to reflect the reduced context size

#### Scenario: Compact on empty or minimal chat
- **WHEN** the operator runs `/compact` with fewer than 3 messages in the chat
- **THEN** Foundry skips compaction and shows a message that there is not enough history to compact

### Requirement: Model picker command
The sidebar chat SHALL support `/model`, which opens a model-selection popup inside the TUI.

The popup SHALL list only models that currently have healthy or OK status in the `Models` tab inventory.

The popup SHALL NOT mutate the global model routing configuration — it only changes the active sidebar chat model.

#### Scenario: Operator opens model picker
- **WHEN** the operator runs `/model`
- **THEN** the monitor opens a popup containing healthy models available to the sidebar chat

#### Scenario: Operator confirms a new model
- **WHEN** the popup is open and the operator presses Enter on a highlighted model
- **THEN** the sidebar chat switches to that model for subsequent turns
- **AND** the selected model is persisted in the session state

#### Scenario: Operator cancels model selection
- **WHEN** the popup is open and the operator presses Esc
- **THEN** the popup closes
- **AND** the previously selected chat model remains unchanged

#### Scenario: Model picker excludes blocked models
- **WHEN** the operator runs `/model`
- **AND** some models are currently blacklisted in the `Models` tab
- **THEN** the popup only shows models with healthy or OK status
- **AND** blacklisted models are not selectable

#### Scenario: Model picker with no healthy models
- **WHEN** the operator runs `/model`
- **AND** all models are currently blacklisted
- **THEN** the popup shows a message that no healthy models are available
- **AND** the current chat model remains unchanged
