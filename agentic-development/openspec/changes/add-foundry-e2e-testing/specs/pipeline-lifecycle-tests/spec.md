# Spec: Pipeline Lifecycle E2E Tests

**Capability:** `pipeline-lifecycle-tests`
**Parent Change:** `add-foundry-e2e-testing`

## ADDED Requirements

### Requirement: Full lifecycle flow tests
The E2E test suite SHALL verify the complete task lifecycle from `todo` through `pending`, `in_progress`, to `completed` or `failed`, using `promoteNextTodoToPending()` and `runPipeline()` with a mocked executor. Each state transition MUST be verified via `state.json` assertions.

#### Scenario: Task completes full lifecycle
- **WHEN** a task starts in `status: "todo"` and `promoteNextTodoToPending()` is called, then `runPipeline()` with agents `["u-coder", "u-validator", "u-summarizer"]` and mock executor returning success
- **THEN** mock executor is called 3 times in order: u-coder, u-validator, u-summarizer
- **AND** task `state.json` has `status: "completed"`
- **AND** `runPipeline` result has `success: true` and `completedAgents: ["u-coder", "u-validator", "u-summarizer"]`

#### Scenario: Task fails when agent returns error
- **WHEN** `runPipeline()` is called with mock executor returning failure for `u-validator`
- **THEN** u-coder succeeds, u-validator fails, u-summarizer is NOT called
- **AND** `runPipeline` result has `success: false`, `failedAgent: "u-validator"`

#### Scenario: HITL waiting pauses pipeline
- **WHEN** `runPipeline()` is called with mock executor returning `exitCode: 75` for `u-architect`
- **THEN** result has `hitlWaiting: true`, `waitingAgent: "u-architect"`
- **AND** subsequent agents are NOT called

### Requirement: Retry flow tests
The E2E test suite SHALL verify the retry flow where a failed task is reset to `todo`, re-promoted, and re-run through the pipeline successfully.

#### Scenario: Failed task retries successfully
- **WHEN** a task in `status: "failed"` with `attempt: 1` is reset to `"todo"`, promoted via `promoteNextTodoToPending()`, and run via `runPipeline()` with mock executor returning success
- **THEN** task `state.json` has `status: "completed"`

#### Scenario: Retry preserves attempt counter
- **WHEN** a task that failed on attempt 1 is retried with attempt incremented to 2
- **THEN** `state.json` reflects `attempt: 2` after completion

### Requirement: Dependency resolution E2E tests
The E2E test suite SHALL verify that `blocked_by` dependencies are respected during task promotion, including chain dependencies and missing dependency handling.

#### Scenario: Blocked task stays todo until dependency completes
- **WHEN** task-A is in `status: "todo"` with `priority: 2` and task-B has `blocked_by: ["task-A"]`
- **THEN** `promoteNextTodoToPending()` promotes task-A (no blockers)
- **AND** task-B remains in `status: "todo"`

#### Scenario: Blocked task promotes after dependency completes
- **WHEN** task-A is in `status: "completed"` and task-B has `blocked_by: ["task-A"]`
- **THEN** `promoteNextTodoToPending()` promotes task-B to `status: "pending"`

#### Scenario: Chain dependencies resolve in order
- **WHEN** task-A (no deps), task-B (`blocked_by: ["task-A"]`), task-C (`blocked_by: ["task-B"]`) are processed sequentially
- **THEN** execution order is task-A, then task-B, then task-C

#### Scenario: Missing dependency blocks task
- **WHEN** task-X has `blocked_by: ["nonexistent"]`
- **THEN** `promoteNextTodoToPending()` does not promote task-X

### Requirement: Single-slot pending gate E2E tests
The E2E test suite SHALL verify that only one task can occupy the pending slot at a time, and that the slot is correctly managed through state transitions.

#### Scenario: Only one task pending at a time
- **WHEN** 3 tasks are in `status: "todo"` and `promoteNextTodoToPending()` is called twice
- **THEN** first call promotes exactly one task to `status: "pending"`
- **AND** second call returns null (pending slot occupied)

#### Scenario: In-progress slot blocks further promotion
- **WHEN** task-A is in `status: "in_progress"` and task-B is in `status: "todo"`
- **THEN** `promoteNextTodoToPending()` returns null (in_progress slot occupied in single-worker mode)

#### Scenario: Worker claiming sets current_step
- **WHEN** `setStateStatus(taskDir, "in_progress", "u-coder")` is called on a pending task
- **THEN** `state.json` has `status: "in_progress"` and `current_step: "u-coder"`
