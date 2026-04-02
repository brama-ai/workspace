# Spec: Monitor Sidebar Chat

**Capability:** `monitor-sidebar-chat`
**Parent Change:** `add-foundry-sidebar-supervisor-chat`

## ADDED Requirements

### Requirement: Global sidebar chat in Foundry monitor
The Foundry monitor SHALL provide a right-hand sidebar chat that remains available from every top-level monitor tab.

#### Scenario: Sidebar stays available while switching tabs
- **WHEN** the operator switches between `Tasks`, `Commands`, `Processes`, and `Models`
- **THEN** the sidebar chat remains visible and usable
- **AND** the main tab content continues to update independently on the left

#### Scenario: Narrow terminal handling
- **WHEN** the terminal width is too small for the full layout
- **THEN** the monitor applies a compact sidebar behavior instead of crashing or corrupting layout

### Requirement: Sidebar chat uses full monitor context
The sidebar chat SHALL receive structured monitor context that includes current activity, task status, summary, handoff, process health, model health, and waiting-answer state.

#### Scenario: Operator asks what is happening now
- **WHEN** the operator asks the sidebar chat for current task status
- **THEN** the response is derived from live monitor context instead of a generic answer
- **AND** the response can reference running steps, failed tasks, waiting-answer tasks, model health, or process problems when present

#### Scenario: Operator asks why pending tasks are not moving
- **WHEN** the operator asks the sidebar chat why pending tasks are not moving
- **THEN** the response uses monitor facts such as worker availability, stale locks, queue state, waiting-answer blocks, or recent task artifacts
- **AND** the response does not fall back to generic pipeline advice when concrete monitor evidence exists

### Requirement: Context size is visible
The sidebar header SHALL show the current context size for the active chat session.

#### Scenario: Header shows context size
- **WHEN** the sidebar is rendered
- **THEN** the header displays the current context size for the active chat session

### Requirement: Latest chat session is restored on restart
The monitor SHALL reopen with the most recently active sidebar chat session after the operator closes and reopens the TUI.

Only `/new` SHALL start a fresh chat history.

#### Scenario: TUI restart restores previous chat
- **WHEN** the operator closes the monitor and opens it again later
- **THEN** the sidebar loads the latest active chat session
- **AND** prior messages, compact memory, selected model, and watch settings remain available

#### Scenario: New chat starts only on slash command
- **WHEN** the operator has an existing sidebar session and reopens the monitor
- **THEN** Foundry does not create a new empty chat automatically
- **AND** a new chat is created only after the operator runs `/new`

### Requirement: Chat compaction preserves continuity
The sidebar chat SHALL support manual compaction through `/compact` and automatic compaction once context size reaches 100k.

Compaction SHALL preserve the same chat session identity and continue the conversation from compacted memory.

#### Scenario: Manual compact keeps same chat
- **WHEN** the operator runs `/compact`
- **THEN** Foundry compresses historical chat context into compact memory
- **AND** the active chat session remains the same chat

#### Scenario: Auto compact at 100k
- **WHEN** chat context reaches 100k
- **THEN** Foundry automatically compacts the chat without requiring operator confirmation
- **AND** the next turn continues in the same chat with updated compact memory
- **AND** the sidebar header updates to reflect the new context size after compaction

### Requirement: Sidebar header displays model and context size
The sidebar header SHALL show the active chat model name and the current context size.

#### Scenario: Header shows model and context
- **WHEN** the sidebar is rendered with an active chat session
- **THEN** the header displays the selected model name and the current context size in a human-readable format (e.g., "42K")

#### Scenario: Header updates after model switch
- **WHEN** the operator switches the chat model via `/model`
- **THEN** the header immediately reflects the new model name

### Requirement: Structured monitor context assembler
The sidebar chat agent SHALL receive structured monitor context assembled from the same data sources used by the TUI tabs, not from scraping rendered text.

The context assembler SHALL include:
- Task counts and selected task state
- Activity from events and current steps
- Summary and handoff content
- QA / waiting-answer state
- Process and zombie status
- Model inventory and blacklist health

#### Scenario: Context assembler with running tasks
- **GIVEN** the monitor has tasks in `in_progress` status
- **WHEN** the context assembler builds a snapshot
- **THEN** the snapshot includes task counts, current agent step, worker id, and elapsed time for running tasks

#### Scenario: Context assembler with no tasks
- **GIVEN** the monitor has no tasks in the task pool
- **WHEN** the context assembler builds a snapshot
- **THEN** the snapshot includes zero counts and empty task lists without errors

#### Scenario: Context assembler with failed and waiting tasks
- **GIVEN** the monitor has tasks in `failed` and `waiting_answer` status
- **WHEN** the context assembler builds a snapshot
- **THEN** the snapshot includes failure details, failed agent names, and pending QA questions

#### Scenario: Context assembler includes model health
- **GIVEN** the monitor has model inventory with some blacklisted models
- **WHEN** the context assembler builds a snapshot
- **THEN** the snapshot includes model health status and blacklist reasons

### Requirement: Session persistence format
The sidebar chat session SHALL be persisted to a local file under Foundry runtime state.

The persisted session SHALL include:
- Chat session id
- Message history or compacted history reference
- Selected model for the chat
- Latest compact memory content
- Active supervision watch jobs with intervals
- Last-opened timestamp

#### Scenario: Session file location
- **WHEN** Foundry persists a sidebar chat session
- **THEN** the session file is stored under `agentic-development/runtime/chat/` directory

#### Scenario: Session file survives TUI restart
- **GIVEN** the operator has an active sidebar chat session
- **WHEN** the operator closes the TUI
- **THEN** the session file remains on disk
- **AND** reopening the TUI restores the session from that file

#### Scenario: Multiple historical sessions
- **GIVEN** the operator has used `/new` to create multiple sessions
- **WHEN** the TUI restarts
- **THEN** only the most recently active session is restored as the current chat
- **AND** previous sessions remain stored but are not loaded automatically
