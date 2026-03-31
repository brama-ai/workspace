# Spec: Monitor Chat Commands

**Capability:** `monitor-chat-commands`
**Parent Change:** `add-foundry-sidebar-supervisor-chat`

## ADDED Requirements

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

### Requirement: Model picker command
The sidebar chat SHALL support `/model`, which opens a model-selection popup inside the TUI.

The popup SHALL list only models that currently have healthy or OK status in the `Models` tab inventory.

#### Scenario: Operator opens model picker
- **WHEN** the operator runs `/model`
- **THEN** the monitor opens a popup containing healthy models available to the sidebar chat

#### Scenario: Operator confirms a new model
- **WHEN** the popup is open and the operator presses Enter on a highlighted model
- **THEN** the sidebar chat switches to that model for subsequent turns

#### Scenario: Operator cancels model selection
- **WHEN** the popup is open and the operator presses Esc
- **THEN** the popup closes
- **AND** the previously selected chat model remains unchanged
