# Design: Foundry Sidebar Supervisor Chat

## Problem

Foundry exposes rich operational data, but the operator cannot converse with that data inside the monitor. The current `foundry supervisor` CLI also creates a second supervision surface that is task-centric instead of monitor-centric.

## Goals

- Add one global sidebar chat to the monitor
- Make the sidebar the primary operator entrypoint for supervision requests
- Give the chat agent access to the full monitor context
- Persist the last active chat session across monitor restarts
- Support slash commands and model switching without leaving the TUI
- Control context growth with visible usage and compaction

## Non-Goals

- Building a general-purpose multi-user chat backend
- Replacing task detail views with generative summaries only
- Removing existing TUI tabs

## Decisions

### 1. Use a global right sidebar, not a separate tab

The chat will live as a persistent right sidebar available from every top-level tab. This keeps the monitor conversational without forcing the operator to leave `Tasks`, `Processes`, or `Models`.

On narrow terminals, the sidebar may collapse to a compact mode or require an explicit toggle, but it remains part of the same monitor session rather than a separate screen.

### 2. Introduce a monitor-scoped Foundry chat agent

The sidebar is backed by a dedicated Foundry chat agent that conceptually evolves the current supervisor behavior. Its job is not only to answer a single prompt, but to reason over the live monitor context and optionally keep watching the system.

This must be implemented as a real Foundry agent contract, not just `opencode run` with an inline prompt. The runtime should resolve a dedicated agent definition such as `.opencode/agents/foundry-monitor-chat.md` so the behavior is inspectable, versioned, and tunable like the rest of the Foundry agent stack.

This agent will:

- answer questions such as "what is happening right now?"
- summarize queue state, stuck tasks, model health, recent failures, and summaries
- accept natural-language supervision requests such as "watch this every 5 minutes"
- use `agentic-development/supervisor.md` as the behavioral contract for periodic supervision

The agent response contract should be operator-first. By default it should answer in a short structured shape:

- `State` — what is happening now
- `Issues` — what is blocked, stale, failed, or risky
- `Next` — what the operator should do now, if anything

If the operator asks a narrow question, the agent can stay concise, but it should still prefer concrete statements from monitor data over generic guidance.

### 3. Build one explicit monitor context assembler

The chat agent should not scrape UI text. Instead, Foundry will assemble a structured context payload from the same sources already used by the TUI:

- task counts and selected task state
- activity from events and current steps
- summary and handoff content
- QA / waiting-answer state
- process and zombie status
- model inventory and blacklist health

The assembler should explicitly include artifact-derived context that operators actually ask about:

- latest `summary.md` status and headline for recent tasks
- latest `handoff.md` sections for active or failed tasks
- recent activity/events for active tasks
- selected-task focus when the operator has a task highlighted in the TUI

This creates one authoritative chat context layer and keeps future additions predictable.

### 4. Persist the latest active chat session locally

The monitor will store sidebar chat state in a dedicated local session file under `agentic-development/runtime/chat/`. Each session is a JSON file named by its chat id. The persisted session includes:

- chat id
- message history or compacted history reference
- selected model for the chat
- latest context summary / compact memory
- active supervision jobs and intervals
- last-opened timestamp

A pointer file (`agentic-development/runtime/chat/latest.json`) tracks which session id is the current active session.

When the monitor restarts, it reopens this latest session by default. A new session is created only when the operator uses `/new`.

### 5. Compaction preserves the same chat identity

`/compact` and auto-compact at 100k both compress history into a durable summary-memory and continue in the same chat id. This avoids confusing the operator with invisible chat rotation while still keeping context bounded.

The compacted memory must be visible to the chat agent as part of subsequent turns.

### 6. Slash commands are inline-first

When the operator types `/`, the sidebar shows available commands similar to OpenCode command suggestions. The initial command set is:

- `/model`
- `/compact`
- `/new`

The suggestion list filters as the operator types.

### 7. `/model` uses a modal picker sourced from healthy models

`/model` opens a popup inside the TUI. The popup reads from the active `Models` tab inventory but only shows models that currently have healthy/OK status.

Behavior:

- Up/Down selects
- Enter confirms and switches the chat model
- Esc cancels and preserves the current model

The popup does not mutate the global model configuration; it only changes the active chat model for subsequent sidebar turns unless product work later expands the scope.

### 8. Supervision becomes chat-native, CLI supervisor becomes compatibility mode

The operator can ask the chat agent to monitor tasks periodically. If no interval is given, the default is 5 minutes.

Examples:

- "Foundry, watch this task every 5 minutes"
- "Check queue health"
- "Keep an eye on failed tasks"

The existing `foundry supervisor` command remains temporarily as a compatibility wrapper that forwards into the same underlying supervision engine or prints a deprecation notice plus migration guidance. Removal should happen in a later change after the new flow is proven.

### 9. Avoid a thin prompt-wrapper implementation

The sidebar assistant should not be implemented as a raw shell call that injects one large string into a generic model invocation without an agent contract. That approach makes the behavior hard to audit and tends to produce vague answers.

Instead, implementation should:

- route through a dedicated sidebar-agent identity
- keep `supervisor.md` as a subordinate behavior contract, not the only source of personality or policy
- make the response format testable
- keep context assembly separate from prompt wording so operator quality can improve without changing state collection

## Data Flow

1. Monitor starts and loads persisted sidebar session state
2. TUI renders the main content plus the right sidebar
3. A context assembler builds the latest structured monitor snapshot
4. User types a message or slash command
5. Slash command path either:
   - updates session state (`/new`, `/compact`), or
   - opens model picker (`/model`)
6. Normal chat message path sends:
   - user message
   - structured monitor context
   - compacted memory (if any)
   - current chat model selection
7. Chat response is rendered in sidebar history and persisted to the session file
8. If the chat schedules supervision, Foundry stores the watch job with interval metadata and runs periodic checks against fresh monitor context
9. When context size reaches 100k, Foundry auto-compacts and records the resulting compact summary in the same session

## Risks and Trade-offs

- A global sidebar is more integrated than a separate tab, but it requires careful width management
- Persisting chat state improves continuity, but stale context must be handled clearly after long gaps
- Deprecating rather than removing `foundry supervisor` keeps compatibility, but means temporary duplicate surfaces
- Using only healthy models for `/model` improves safety, but hides broken models from direct experimentation in chat

## New Module Map

| Module | Path | Responsibility |
|--------|------|----------------|
| Chat session state | `monitor/src/state/chat-session.ts` | Session CRUD, persistence, restore |
| Context assembler | `monitor/src/lib/context-assembler.ts` | Build structured monitor snapshot for chat agent |
| Slash commands | `monitor/src/lib/slash-commands.ts` | Command registry, filtering, suggestion UX logic |
| Chat agent | `monitor/src/agents/chat-agent.ts` | Agent execution, supervision scheduling, watch jobs |
| Sidebar agent contract | `.opencode/agents/foundry-monitor-chat.md` | Versioned agent prompt and operator behavior contract |
| Supervisor contract | `agentic-development/supervisor.md` | Behavioral rules for supervision passes |
| Session storage | `agentic-development/runtime/chat/` | Persisted session files and latest pointer |

## Verification Plan

- **Unit tests (Tier 2):** slash-command filtering, context assembler shape, auto-compact threshold logic, model picker filtering
- **Unit tests (Tier 2):** slash-command filtering, context assembler shape, auto-compact threshold logic, model picker filtering, response-shape helpers
- **Integration tests (Tier 3):** session persistence round-trip (real tmpdir), `/new` and `/compact` state transitions, watch job scheduling with default interval, session restore after simulated restart, dedicated agent prompt loading, artifact-enriched context assembly
- **Manual TUI verification:** sidebar layout on wide/narrow terminals, popup keyboard handling, slash suggestion UX
- Framework: Vitest (existing `monitor/vitest.config.ts`)
- All test files in `monitor/src/__tests__/` following `<module>.test.ts` naming convention
