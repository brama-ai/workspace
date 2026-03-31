# Tasks: Add Foundry Sidebar Supervisor Chat

**Change ID:** `add-foundry-sidebar-supervisor-chat`

## Phase 1: Sidebar Chat Foundations

- [ ] **1.1** Add a global right sidebar chat shell to the monitor
  - Render it alongside all top-level tabs
  - Define responsive behavior for narrow terminal widths
  - Show context size and active chat model in the sidebar header
  - **Verify:** manual `foundry monitor` check on wide and narrow terminals

- [ ] **1.2** Add monitor-scoped chat session persistence
  - Persist the latest active chat session to local runtime state
  - Restore that session when the TUI is reopened
  - Do not create a fresh session automatically on restart
  - **Verify:** integration test covers close/reopen restore behavior

- [ ] **1.3** Add a structured monitor context assembler
  - Include activity, task status, selected task detail, summary, handoff, process health, model health, and waiting-answer state
  - Feed the structured payload to the sidebar chat agent instead of scraping rendered text
  - **Verify:** unit test covers empty, running, failed, and waiting-answer states

## Phase 2: Chat Commands and Context Control

- [ ] **2.1** Add slash-command suggestion UX for sidebar input
  - Show suggestions when the operator types `/`
  - Filter suggestions as the operator keeps typing
  - Initial commands: `/model`, `/compact`, `/new`
  - **Verify:** manual TUI test confirms selection and filtering behavior

- [ ] **2.2** Implement `/new` and `/compact`
  - `/new` starts a fresh chat history and marks it as the latest active session
  - `/compact` compresses the current history into compact memory and continues in the same chat id
  - **Verify:** integration test covers history reset and same-session compaction

- [ ] **2.3** Add automatic compaction at 100k context
  - Trigger compaction without operator confirmation once the threshold is reached
  - Preserve continuity in the same chat session
  - Update the header to reflect new context usage after compaction
  - **Verify:** unit test simulates threshold crossing and confirms persisted compact memory

## Phase 3: Model Selection and Supervisor Behavior

- [ ] **3.1** Implement `/model` popup selection
  - Source selectable entries from healthy/OK models already known to the monitor
  - Use Enter to confirm and Esc to cancel
  - Change only the active sidebar chat model, not the global model routing config
  - **Verify:** integration or component test covers confirm and cancel flows

- [ ] **3.2** Add the Foundry chat agent and supervision scheduler
  - Create a monitor-scoped agent path that can answer from monitor context
  - Support natural-language watch requests and default to 5 minutes if no interval is provided
  - Persist active watch jobs in sidebar session state
  - **Verify:** integration test covers a watch request with omitted interval defaulting to 5 minutes

- [ ] **3.3** Introduce `agentic-development/supervisor.md` as the supervision contract
  - Document what the chat agent checks, how often, and which signals matter most
  - Cover stalled tasks, failed summaries, zombie workers, pending bottlenecks, and model health
  - **Verify:** referenced by implementation docs and used by the chat agent prompt/runtime

- [ ] **3.4** Deprecate legacy `foundry supervisor`
  - Update CLI help and command output to mark it as deprecated
  - Route it through the new supervision engine or provide migration guidance to sidebar chat
  - Keep compatibility for one release window instead of removing it immediately
  - **Verify:** manual command run confirms deprecation behavior and non-breaking exit path

## Phase 4: Documentation and Validation

- [ ] **4.1** Update Foundry operator documentation
  - Document sidebar layout, slash commands, model picker, persistence, and auto-compact behavior
  - Document supervisor deprecation and the new chat-native supervision workflow

- [ ] **4.2** Add or extend tests for chat/session behavior
  - Session restore
  - Slash command suggestions
  - `/new` and `/compact`
  - 100k auto-compact
  - `/model` popup selection
  - 5-minute default watch interval

- [ ] **4.3** Validate the OpenSpec change with `openspec validate add-foundry-sidebar-supervisor-chat --strict`
