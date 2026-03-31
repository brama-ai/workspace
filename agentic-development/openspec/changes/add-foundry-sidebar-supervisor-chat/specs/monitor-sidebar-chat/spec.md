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
