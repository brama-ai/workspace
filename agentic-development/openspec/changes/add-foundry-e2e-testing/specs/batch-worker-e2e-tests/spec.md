# Spec: Batch Worker E2E Tests

**Capability:** `batch-worker-e2e-tests`
**Parent Change:** `add-foundry-e2e-testing`

## ADDED Requirements

### Requirement: Priority-based promotion E2E tests
The E2E test suite SHALL verify that `promoteNextTodoToPending()` correctly respects task priority ordering, skips completed tasks, and handles equal-priority scenarios deterministically.

#### Scenario: Highest priority task promoted first
- **WHEN** task-low has `priority: 1` and task-high has `priority: 2`, both in `status: "todo"`
- **THEN** `promoteNextTodoToPending()` promotes task-high to `status: "pending"`
- **AND** task-low remains in `status: "todo"`

#### Scenario: Equal priority tasks promoted deterministically
- **WHEN** task-a and task-b both have `priority: 1` and `status: "todo"`
- **THEN** `promoteNextTodoToPending()` promotes exactly one task
- **AND** the other remains in `status: "todo"`

#### Scenario: Completed tasks skipped during promotion
- **WHEN** task-done has `status: "completed"` and task-todo has `status: "todo"`
- **THEN** `promoteNextTodoToPending()` promotes task-todo

### Requirement: Blocked-by dependency in batch context E2E tests
The E2E test suite SHALL verify that `blocked_by` dependencies interact correctly with priority ordering and the single-slot pending gate in batch scenarios.

#### Scenario: Blocked task skipped even if highest priority
- **WHEN** task-dep is `in_progress`, task-blocked has `priority: 10` with `blocked_by: ["task-dep"]`, and task-free has `priority: 1`
- **THEN** `promoteNextTodoToPending()` returns null (in_progress slot full)
- **AND** both task-blocked and task-free remain in `status: "todo"`

#### Scenario: Multiple dependencies must all be completed
- **WHEN** dep-a is `completed`, dep-b is `in_progress`, and task-multi has `blocked_by: ["dep-a", "dep-b"]`
- **THEN** task-multi remains in `status: "todo"` (dep-b not completed)

#### Scenario: Dependency resolution cascades correctly
- **WHEN** task-1 (no deps), task-2 (`blocked_by: ["task-1"]`), task-3 (`blocked_by: ["task-2"]`) are processed sequentially with promote-run-complete cycles
- **THEN** execution order is task-1, then task-2, then task-3

### Requirement: Worker pool spawn and reap simulation E2E tests
The E2E test suite SHALL verify worker claiming, releasing, and cleanup behavior using mocked child processes. Tests MUST verify atomic claiming and correct state management on failure.

#### Scenario: Worker claims task atomically
- **WHEN** `setStateStatus(taskDir, "in_progress", "u-coder")` is called on a pending task
- **THEN** `state.json` has `status: "in_progress"` and `current_step: "u-coder"`

#### Scenario: Worker releases task on failure
- **WHEN** `setStateStatus(taskDir, "failed", "u-coder")` is called on an in_progress task
- **THEN** `state.json` has `status: "failed"`
- **AND** the task is available for retry (can be reset to todo)

#### Scenario: Worker cleanup on completion
- **WHEN** pipeline completes and `setStateStatus(taskDir, "completed")` is called
- **THEN** `state.json` has `status: "completed"`

### Requirement: Headless watch mode E2E tests
The E2E test suite SHALL verify the watch loop's polling behavior, dynamic worker count reading, and clean exit using fake timers. Tests MUST NOT use real timers or real polling intervals.

#### Scenario: Watch loop promotes tasks on interval
- **WHEN** 3 tasks are in `status: "todo"` and fake timers advance by the poll interval
- **THEN** one task is promoted to `status: "pending"` per cycle
- **AND** tasks are processed sequentially as each completes

#### Scenario: Dynamic worker count from config file
- **WHEN** config file `monitor-workers` contains `3`
- **THEN** batch worker reads worker count as 3
- **AND** updating the file to `5` changes the count on next read

#### Scenario: Watch loop exits cleanly on signal
- **WHEN** a simulated SIGTERM is received during watch loop
- **THEN** the loop stops polling
- **AND** any in-progress task state files remain valid JSON

### Requirement: Singleton lock contention E2E tests
The E2E test suite SHALL verify that the singleton lock prevents concurrent batch instances, handles stale locks from dead processes, and releases correctly on exit.

#### Scenario: First instance acquires lock
- **WHEN** `acquireLock(lockFile)` is called with no existing lock
- **THEN** returns `{ acquired: true }` and lock file contains current PID

#### Scenario: Second instance fails to acquire lock
- **WHEN** lock file exists with a live PID and `acquireLock(lockFile)` is called
- **THEN** returns `{ acquired: false, existingPid: <pid> }`

#### Scenario: Stale lock from dead process cleaned up
- **WHEN** lock file contains PID `999999999` (dead process) and `acquireLock(lockFile)` is called
- **THEN** stale lock is removed and returns `{ acquired: true }`

#### Scenario: Lock released on normal exit
- **WHEN** `releaseLock(lockFile)` is called after acquiring
- **THEN** lock file is deleted and subsequent `acquireLock()` succeeds
