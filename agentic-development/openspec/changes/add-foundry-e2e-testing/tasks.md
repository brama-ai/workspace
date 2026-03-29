# Tasks: Add E2E Testing Infrastructure for Foundry Pipeline

**Change ID:** `add-foundry-e2e-testing`

## Phase 1: Test Infrastructure Helpers

- [ ] **1.1** Create `monitor/src/__tests__/helpers/mock-executor.ts` — shared mock executor factory
  - `createMockExecutor(behaviors)` returns a `vi.fn()` that dispatches by agent name
  - Pre-built behaviors: `successBehavior`, `failBehavior`, `hitlBehavior`, `timeoutBehavior`
  - `AgentCallRecord` tracking for assertion on call order and arguments
  - Must satisfy `AgentResult` TypeScript interface strictly
  - **Verify:** `tsc --noEmit` passes, types match `agents/executor.ts` exports

- [ ] **1.2** Create `monitor/src/__tests__/helpers/git-fixture.ts` — temp git repo fixture
  - `createGitRepo(prefix)` → initializes bare git repo in tmpdir with `main` branch
  - `createBranch(name)`, `checkout(name)`, `commit(message, files)` helpers
  - `cleanup()` removes temp directory
  - **Verify:** Unit test in `__tests__/helpers/git-fixture.test.ts` — create repo, branch, commit, verify log

- [ ] **1.3** Extend `monitor/src/__tests__/helpers/fixtures.ts` — add scenario builders
  - `createTaskScenario(root, tasks[])` — creates multiple tasks with dependencies
  - `createRetryScenario(root, slug, attempt)` — creates a failed task ready for retry
  - `createStalledScenario(root, slug, minutesAgo)` — creates in_progress task with old events
  - **Verify:** Existing tests still pass (`vitest run`)

- [ ] **1.4** Update `monitor/vitest.config.ts` — add E2E test configuration
  - Add `testTimeout: 30000` for E2E tests (default 5000 is too short)
  - Ensure `__tests__/e2e/**/*.test.ts` is included in test glob
  - **Verify:** `vitest run` discovers both unit and E2E test files

## Phase 2: Pipeline Lifecycle E2E Tests

- [ ] **2.1** Create `monitor/src/__tests__/e2e/pipeline-lifecycle.test.ts`
  - Test: `todo → pending → in_progress → completed` full flow via `promoteNextTodoToPending()` + `runPipeline()`
  - Test: `todo → pending → in_progress → failed` when mock executor returns failure
  - Test: `failed → todo → pending → in_progress → completed` retry flow
  - Test: HITL waiting state (`exitCode: 75`) pauses pipeline correctly
  - Mock `executeAgent` via shared `createMockExecutor()`
  - Mock `context-guard` to avoid opencode DB calls
  - Assert `state.json` status at each transition
  - **Verify:** `vitest run src/__tests__/e2e/pipeline-lifecycle.test.ts` — all green

- [ ] **2.2** Add blocked_by dependency resolution E2E tests
  - Test: Task with `blocked_by: ["dep-task"]` stays todo until dep completes
  - Test: Multiple tasks with chain dependencies resolve in correct order
  - Test: Circular dependency detection (if implemented) or graceful handling
  - **Verify:** `vitest run src/__tests__/e2e/pipeline-lifecycle.test.ts` — all green

- [ ] **2.3** Add single-slot pending gate E2E tests
  - Test: Only one task can be pending at a time across multiple todo tasks
  - Test: After pending task moves to in_progress, next todo can be promoted
  - Test: Worker claiming sets correct `current_step` and `worker_id`
  - **Verify:** `vitest run src/__tests__/e2e/pipeline-lifecycle.test.ts` — all green

## Phase 3: Supervisor E2E Tests

- [ ] **3.1** Create `monitor/src/__tests__/e2e/supervisor-e2e.test.ts`
  - Test: Stall detection with fake timers — task idle > threshold triggers stall
  - Test: `diagnose()` → `checkStall()` → root-cause report generation flow
  - Test: Root-cause report file (`root-cause-N.md`) is created with correct content
  - Use `vi.useFakeTimers()` for all time-dependent assertions
  - **Verify:** `vitest run src/__tests__/e2e/supervisor-e2e.test.ts` — all green

- [ ] **3.2** Add auto-retry on failure E2E tests
  - Test: Failed task → diagnose → retry action → state reset to todo → re-run succeeds
  - Test: Retry increments `attempt` counter in state.json
  - Test: Max retry limit (3 attempts) stops retry loop
  - **Verify:** `vitest run src/__tests__/e2e/supervisor-e2e.test.ts` — all green

- [ ] **3.3** Add FAIL summary analysis E2E tests
  - Test: `getSummaryStatus()` detects FAIL → triggers diagnosis flow
  - Test: Failed agents list is extracted correctly from state
  - Test: Cost tracking across retry attempts accumulates correctly
  - **Verify:** `vitest run src/__tests__/e2e/supervisor-e2e.test.ts` — all green

## Phase 4: Batch Worker E2E Tests

- [ ] **4.1** Create `monitor/src/__tests__/e2e/batch-worker.test.ts`
  - Test: `promoteNextTodoToPending()` respects priority ordering
  - Test: `promoteNextTodoToPending()` respects `blocked_by` dependencies
  - Test: Multiple promote calls with task completions between them
  - **Verify:** `vitest run src/__tests__/e2e/batch-worker.test.ts` — all green

- [ ] **4.2** Add worker pool spawn/reap simulation tests
  - Test: Worker claims task atomically (no double-claim)
  - Test: Worker releases task on failure (state → failed, worker_id cleared)
  - Test: Worker cleanup on SIGTERM (graceful shutdown)
  - Mock `child_process.spawn` for worker process simulation
  - **Verify:** `vitest run src/__tests__/e2e/batch-worker.test.ts` — all green

- [ ] **4.3** Add headless watch mode tests
  - Test: Watch loop promotes todo → pending on interval
  - Test: Dynamic worker count from config file
  - Test: Watch loop exits cleanly on signal
  - Use `vi.useFakeTimers()` + `vi.advanceTimersByTime()` for polling simulation
  - **Verify:** `vitest run src/__tests__/e2e/batch-worker.test.ts` — all green

- [ ] **4.4** Add singleton lock contention tests
  - Test: Second batch instance fails to acquire lock
  - Test: Stale lock (dead PID) is cleaned up and re-acquired
  - Test: Lock is released on normal exit and on error exit
  - **Verify:** `vitest run src/__tests__/e2e/batch-worker.test.ts` — all green

## Final Validation

- [ ] **5.1** Run full test suite — `vitest run` from `monitor/` — all tests pass
- [ ] **5.2** Verify total test time < 60 seconds
- [ ] **5.3** Verify no new npm dependencies added to `package.json`
