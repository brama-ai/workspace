# Spec: Supervisor E2E Tests

**Capability:** `supervisor-e2e-tests`
**Parent Change:** `add-foundry-e2e-testing`

## ADDED Requirements

### Requirement: Stall detection E2E tests
The E2E test suite SHALL verify stall detection across different agents and task statuses using fake timers. Tests MUST cover agent-specific thresholds, pending task thresholds, and the fallback to `state.json` mtime when no events exist.

#### Scenario: Stall detected when idle exceeds agent threshold
- **WHEN** a task is in `status: "in_progress"` with `current_step: "u-coder"` and last event was 25 minutes ago
- **THEN** `checkStall()` returns `stalled: true` with `idleSec` approximately 1500 and `threshold: 1200`

#### Scenario: No stall when task has recent activity
- **WHEN** a task is in `status: "in_progress"` with last event 5 minutes ago
- **THEN** `checkStall()` returns `stalled: false`

#### Scenario: Agent-specific thresholds respected
- **WHEN** a task has `current_step: "u-summarizer"` and last event was 8 minutes ago
- **THEN** `checkStall()` returns `stalled: true` with `threshold: 300` (5 min for u-summarizer)

#### Scenario: Pending task uses pending threshold
- **WHEN** a task is in `status: "pending"` with last event 10 minutes ago
- **THEN** `checkStall()` returns `stalled: true` with `threshold: 360` (6 min)

### Requirement: Root-cause report generation E2E tests
The E2E test suite SHALL verify that `diagnose()` correctly categorizes failures and that root-cause reports can be generated from diagnosis results. Tests MUST cover timeout, rate limit, git conflict, zombie, and agent error categories.

#### Scenario: Timeout diagnosis
- **WHEN** a failed task has events containing "hard_timeout exit code 124"
- **THEN** `diagnose()` returns `category: "timeout"` and `action: "retry_with_split"`

#### Scenario: Rate limit diagnosis
- **WHEN** a failed task has events containing "HTTP 429 rate limit"
- **THEN** `diagnose()` returns `category: "rate_limit"` and `action: "wait_retry"`

#### Scenario: Git conflict diagnosis
- **WHEN** a failed task has events containing "merge conflict"
- **THEN** `diagnose()` returns `category: "git_conflict"` and `action: "manual"`

#### Scenario: Zombie process diagnosis
- **WHEN** a failed task has events containing "stale lock detected, zombie process"
- **THEN** `diagnose()` returns `category: "zombie"` and `action: "clean_retry"`

#### Scenario: Agent error with log snippet
- **WHEN** a failed task has u-coder failed and agent log contains error details
- **THEN** `diagnose()` returns `category: "agent_error"` and `detail` contains "u-coder"

### Requirement: Auto-retry on failure E2E tests
The E2E test suite SHALL verify the complete retry flow: diagnose failure, reset state, re-promote, and re-run pipeline. Tests MUST cover successful retry, max attempt limit, and action-specific retry behavior.

#### Scenario: Supervisor retries failed task successfully
- **WHEN** a task in `status: "failed"` with `attempt: 1` is diagnosed with `action: "retry"`, state is reset to `"todo"`, promoted, and re-run with mock executor returning success
- **THEN** task `state.json` has `status: "completed"`

#### Scenario: Max retry limit stops retry loop
- **WHEN** a task has `attempt: 3` (max retries = 3) and `diagnose()` returns `action: "retry"`
- **THEN** retry is NOT attempted and task remains in failed state

#### Scenario: Manual action prevents automatic retry
- **WHEN** `diagnose()` returns `action: "manual"` (e.g., git conflict)
- **THEN** no automatic retry is attempted and task remains in failed state

### Requirement: FAIL summary analysis E2E tests
The E2E test suite SHALL verify that summary status detection, failed agent extraction, and cost tracking work correctly in an integrated flow.

#### Scenario: FAIL detected from Ukrainian summary
- **WHEN** a task has `summary.md` containing `**Статус:** FAIL`
- **THEN** `getSummaryStatus()` returns `"FAIL"`

#### Scenario: PASS detected from English summary
- **WHEN** a task has `summary.md` containing `**Status:** PASS`
- **THEN** `getSummaryStatus()` returns `"PASS"`

#### Scenario: Failed agents extracted from state
- **WHEN** task state has agents `{ "u-planner": { status: "done" }, "u-coder": { status: "failed" }, "u-tester": { status: "failed" } }`
- **THEN** `getFailedAgents()` returns `["u-coder", "u-tester"]`

#### Scenario: Total cost accumulated across agents
- **WHEN** task state has agents with costs `0.5`, `1.2`, and `0.1`
- **THEN** `getTotalCost()` returns approximately `1.8`
