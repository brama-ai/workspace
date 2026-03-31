# Spec: Supervisor Chat Agent

**Capability:** `supervisor-chat-agent`
**Parent Change:** `add-foundry-sidebar-supervisor-chat`

## ADDED Requirements

### Requirement: Chat-native Foundry supervision
Foundry SHALL provide a chat-native supervision agent in the monitor sidebar that can answer questions about the current monitor state and schedule repeated supervision checks.

#### Scenario: Operator asks for current supervision summary
- **WHEN** the operator asks the sidebar chat what is happening with current tasks
- **THEN** the Foundry chat agent summarizes the latest queue state, failures, stalls, or waiting-answer tasks from monitor context

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
