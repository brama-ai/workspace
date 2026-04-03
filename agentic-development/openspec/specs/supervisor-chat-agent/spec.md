# supervisor-chat-agent Specification

## Purpose
Define the dedicated Foundry sidebar supervision agent, its operator response contract, and watch-job behavior.
## Requirements
### Requirement: Dedicated sidebar agent contract
Foundry SHALL implement the sidebar assistant through a dedicated agent definition file rather than only through an ad-hoc inline prompt.

#### Scenario: Sidebar runtime loads dedicated agent definition
- **WHEN** the sidebar chat handles a user message
- **THEN** Foundry resolves a dedicated sidebar agent contract from the repository
- **AND** supervision behavior from `agentic-development/supervisor.md` is applied as part of that agent behavior rather than being the only contract source

### Requirement: Chat-native Foundry supervision
Foundry SHALL provide a chat-native supervision agent in the monitor sidebar that can answer questions about the current monitor state and schedule repeated supervision checks.

#### Scenario: Operator asks for current supervision summary
- **WHEN** the operator asks the sidebar chat what is happening with current tasks
- **THEN** the Foundry chat agent summarizes the latest queue state, failures, stalls, or waiting-answer tasks from monitor context

### Requirement: Operator-facing response quality
The sidebar assistant SHALL answer in a concise operator-focused format that highlights current state, detected issues, and recommended next actions.

#### Scenario: Concrete answer beats generic advice
- **WHEN** the operator asks a status question and the monitor context contains concrete evidence
- **THEN** the assistant names the relevant pending, failed, stalled, or waiting tasks directly
- **AND** the assistant recommends the most relevant next action instead of only describing generic expected behavior

#### Scenario: Operator asks for periodic supervision
- **WHEN** the operator asks the sidebar chat to keep watching execution
- **THEN** Foundry creates a supervision watch job linked to the active chat session
- **AND** later supervision updates are posted back into that same chat

### Requirement: Default supervision interval
If the operator asks for supervision without specifying an interval, Foundry SHALL default to a 5-minute supervision interval.

#### Scenario: Interval omitted
- **WHEN** the operator asks the chat to keep watching a task or the queue without naming an interval
- **THEN** Foundry schedules checks every 5 minutes by default

#### Scenario: Interval specified explicitly
- **WHEN** the operator asks the chat to check every 10 minutes
- **THEN** Foundry schedules checks every 10 minutes instead of the default

### Requirement: Supervisor contract file
Foundry SHALL define sidebar supervision behavior in `agentic-development/supervisor.md`.

#### Scenario: Supervision rules are externalized
- **WHEN** the chat agent decides what to inspect during a scheduled supervision pass
- **THEN** it follows the monitoring priorities and instructions documented in `agentic-development/supervisor.md`

### Requirement: Legacy supervisor command is deprecated
The legacy `foundry supervisor` CLI SHALL be deprecated after sidebar supervision is introduced.

The command SHALL remain as a compatibility path during a deprecation window instead of being removed immediately.

#### Scenario: Operator runs deprecated supervisor command
- **WHEN** the operator runs `foundry supervisor`
- **THEN** Foundry shows a deprecation notice that points to the sidebar chat workflow
- **AND** the command remains non-breaking during the deprecation window
- **AND** the existing supervisor functionality continues to work for the duration of the deprecation period

#### Scenario: Deprecated supervisor help text
- **WHEN** the operator runs `foundry supervisor --help` or `foundry --help`
- **THEN** the help output marks `supervisor` as deprecated
- **AND** suggests using `foundry monitor` sidebar chat instead

### Requirement: Supervision watch jobs persist across restarts
Active supervision watch jobs SHALL be stored in the sidebar session state and restored when the TUI restarts.

#### Scenario: Watch job survives restart
- **GIVEN** the operator has asked the sidebar chat to watch tasks every 5 minutes
- **WHEN** the operator closes and reopens the TUI
- **THEN** the watch job resumes from the persisted session state
- **AND** the next supervision check runs at the scheduled interval

#### Scenario: Watch job cancellation
- **WHEN** the operator asks the sidebar chat to stop watching
- **THEN** Foundry cancels the active watch job
- **AND** the session state is updated to remove the cancelled job

### Requirement: Supervision checks use fresh context
Each scheduled supervision check SHALL use a freshly assembled monitor context snapshot, not stale data from the previous check.

#### Scenario: Supervision check uses current state
- **GIVEN** a watch job is active with a 5-minute interval
- **WHEN** the next supervision check fires
- **THEN** the chat agent receives a fresh monitor context snapshot assembled at check time
- **AND** the response reflects the current state of tasks, processes, and models
