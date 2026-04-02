# Tasks: Add Foundry Sidebar Supervisor Chat

**Change ID:** `add-foundry-sidebar-supervisor-chat`

## Phase 1: Sidebar Chat Foundations

- [x] **1.1** Add a global right sidebar chat shell to the monitor
  - Render it alongside all top-level tabs in `monitor/src/components/App.tsx`
  - Define responsive behavior for narrow terminal widths (collapse or toggle)
  - Show context size and active chat model in the sidebar header
  - Add sidebar toggle state to the main App component
  - **Verify:** manual `foundry monitor` check on wide and narrow terminals

- [x] **1.2** Add monitor-scoped chat session persistence
  - Create `monitor/src/state/chat-session.ts` for session CRUD
  - Persist the latest active chat session to `agentic-development/runtime/chat/`
  - Session file includes: chat id, message history, selected model, compact memory, watch jobs, last-opened timestamp
  - Restore that session when the TUI is reopened
  - Do not create a fresh session automatically on restart
  - **Verify:** integration test in `__tests__/chat-session.test.ts` covers:
    - Create session → write to disk → read back → verify all fields round-trip
    - Close/reopen restore behavior (write session, create new instance, verify restore)
    - Multiple sessions: `/new` creates second session, latest is restored
  - **Test pattern:** real tmpdir, no mocks (per CONVENTIONS.md Tier 3)

- [x] **1.3** Add a structured monitor context assembler
  - Create `monitor/src/lib/context-assembler.ts`
  - Include activity, task status, selected task detail, summary, handoff, process health, model health, and waiting-answer state
  - Feed the structured payload to the sidebar chat agent instead of scraping rendered text
  - Reuse existing data sources: `readAllTasks()`, `getProcessStatusAsync()`, `loadModelInventory()`, `getAllBlacklistEntries()`
  - **Verify:** unit test in `__tests__/context-assembler.test.ts` covers:
    - Empty state (no tasks, no processes, no models) → valid snapshot with zero counts
    - Running tasks → snapshot includes current step, worker id, elapsed time
    - Failed + waiting-answer tasks → snapshot includes failure details and QA questions
    - Model health → snapshot includes blacklist status and reasons
  - **Test pattern:** unit tests with fixture data (per CONVENTIONS.md Tier 2)

## Phase 2: Chat Commands and Context Control

- [x] **2.1** Add slash-command suggestion UX for sidebar input
  - Create `monitor/src/lib/slash-commands.ts` for command registry and filtering
  - Show suggestions when the operator types `/`
  - Filter suggestions as the operator keeps typing
  - Initial commands: `/model`, `/compact`, `/new`
  - **Verify:** unit test in `__tests__/slash-commands.test.ts` covers:
    - `/` shows all 3 commands
    - `/mo` filters to `/model`
    - `/x` shows no matches
    - Empty input shows no suggestions
  - **Verify:** manual TUI test confirms selection and filtering behavior

- [x] **2.2** Implement `/new` and `/compact`
  - `/new` starts a fresh chat history and marks it as the latest active session
  - Previous session remains stored as historical state
  - `/compact` compresses the current history into compact memory and continues in the same chat id
  - `/compact` on fewer than 3 messages skips compaction with a message
  - **Verify:** integration test in `__tests__/chat-commands.test.ts` covers:
    - `/new` creates new session, old session preserved on disk
    - `/compact` compresses history, same chat id preserved
    - `/compact` on minimal history returns skip message
  - **Test pattern:** real tmpdir for session files (per CONVENTIONS.md Tier 3)

- [x] **2.3** Add automatic compaction at 100k context
  - Trigger compaction without operator confirmation once the threshold is reached
  - Preserve continuity in the same chat session
  - Update the header to reflect new context usage after compaction
  - Reuse threshold logic from existing `agents/context-guard.ts` where applicable
  - **Verify:** unit test in `__tests__/chat-auto-compact.test.ts` covers:
    - Context at 99k → no compaction triggered
    - Context at 100k → compaction triggered
    - Context at 150k → compaction triggered
    - After compaction → same session id, compact memory populated
  - **Test pattern:** unit test with mocked context size (per CONVENTIONS.md Tier 2)

## Phase 3: Model Selection and Supervisor Behavior

- [x] **3.1** Implement `/model` popup selection
  - Source selectable entries from healthy/OK models already known to the monitor via `loadModelInventory()` and `getAllBlacklistEntries()`
  - Use Enter to confirm and Esc to cancel
  - Change only the active sidebar chat model, not the global model routing config
  - Handle edge case: all models blacklisted → show "no healthy models" message
  - **Verify:** integration or component test in `__tests__/model-picker.test.ts` covers:
    - Confirm flow: select model → Enter → session model updated
    - Cancel flow: Esc → model unchanged
    - Blacklisted models excluded from picker list
    - All models blacklisted → empty picker with message
  - **Test pattern:** unit tests with fixture model inventory (per CONVENTIONS.md Tier 2)

- [x] **3.2** Add the Foundry chat agent and supervision scheduler
  - Create a monitor-scoped agent path in `monitor/src/agents/chat-agent.ts`
  - Agent can answer from assembled monitor context
  - Support natural-language watch requests and default to 5 minutes if no interval is provided
  - Persist active watch jobs in sidebar session state
  - Each scheduled check uses a freshly assembled context snapshot
  - **Verify:** integration test in `__tests__/chat-agent.test.ts` covers:
    - Watch request with omitted interval → defaults to 5 minutes (300 seconds)
    - Watch request with explicit interval → uses specified interval
    - Watch job persisted in session state
    - Watch cancellation removes job from session state
  - **Test pattern:** integration test with mocked agent executor (per CONVENTIONS.md Tier 3)

- [ ] **3.2a** Replace prompt-wrapper execution with a dedicated sidebar agent contract
  - Add `.opencode/agents/foundry-monitor-chat.md`
  - Move sidebar-agent role, operator response format, and supervision behavior into the dedicated agent definition
  - Keep `agentic-development/supervisor.md` as a referenced behavioral contract for periodic monitoring
  - Avoid relying on a generic raw `opencode run --no-session` prompt as the sole behavior definition
  - **Verify:** integration test confirms sidebar chat runtime loads the dedicated agent contract

- [ ] **3.2b** Enrich chat context with operator-relevant artifacts
  - Extend `monitor/src/lib/context-assembler.ts` to include summary, handoff, recent activity, and selected-task focus
  - Ensure the chat can explain why tasks are pending, blocked, failed, or waiting for input using artifact-derived facts
  - **Verify:** unit/integration tests confirm context payload includes summary and handoff signals for active or failed tasks

- [ ] **3.2c** Standardize sidebar response quality
  - Require a concise operator-facing response shape: state, issues, next actions
  - Ensure answers prefer concrete monitor facts over generic best-practice prose
  - **Verify:** chat-agent tests cover a queue-health question and assert the response includes concrete pending-task analysis

- [x] **3.3** Introduce `agentic-development/supervisor.md` as the supervision contract
  - Document what the chat agent checks during supervision passes
  - Cover: stalled tasks, failed summaries, zombie workers, pending bottlenecks, model health, waiting-answer tasks
  - Define monitoring priorities and signal importance ranking
  - Reference from chat agent prompt/runtime
  - **Verify:** file exists and is referenced by chat agent implementation

- [x] **3.4** Deprecate legacy `foundry supervisor`
  - Update `monitor/src/cli/supervisor.ts` to emit deprecation notice at start
  - Update `monitor/src/cli/foundry.ts` help text to mark `supervisor` as deprecated
  - Route through existing supervisor engine or provide migration guidance to sidebar chat
  - Keep compatibility for one release window instead of removing immediately
  - **Verify:** manual command run confirms deprecation notice and non-breaking exit path
  - **Verify:** unit test in `__tests__/supervisor-deprecation.test.ts` covers:
    - `foundry supervisor` still executes without error
    - Deprecation notice is emitted to stderr or stdout

## Phase 4: Documentation and Validation

- [x] **4.1** Update Foundry operator documentation
  - Document sidebar layout, slash commands, model picker, persistence, and auto-compact behavior
  - Document supervisor deprecation and the new chat-native supervision workflow
  - Update `agentic-development/CONVENTIONS.md` code structure section with new modules

- [x] **4.2** Add or extend tests for chat/session behavior
  - All test files follow naming convention: `__tests__/<module>.test.ts`
  - Test tiers per CONVENTIONS.md:
    - **Unit (Tier 2):** slash-commands, context-assembler, auto-compact threshold, model picker filtering
    - **Integration (Tier 3):** session persistence round-trip, `/new` and `/compact` state transitions, watch job scheduling, session restore
  - Framework: Vitest (existing `monitor/vitest.config.ts`)
  - Shared helpers: extend `__tests__/helpers/fixtures.ts` with chat session fixtures
  - Run: `cd agentic-development/monitor && npm test`
  - Add coverage for dedicated sidebar-agent prompt loading and artifact-enriched context assembly

- [x] **4.3** Validate the OpenSpec change
  - Run `openspec validate add-foundry-sidebar-supervisor-chat --strict` from `agentic-development/`
  - Verify all specs, proposal, design, and tasks are consistent
