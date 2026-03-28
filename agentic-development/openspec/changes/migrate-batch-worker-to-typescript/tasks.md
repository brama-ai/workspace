# Tasks: Migrate Batch Worker Pool to TypeScript

## Phase 1: State Layer Extensions

### Task 1.1: Add task claiming functions to task-state-v2.ts

Add atomic task claiming and promotion functions to `monitor/src/state/task-state-v2.ts`:

- [ ] `claimTask(taskDir: string, workerId: string): boolean` — Atomic claim using `O_CREAT | O_EXCL` lock file. Reads state, checks status === "pending", writes status = "in_progress" + worker_id + claimed_at, releases lock. Returns false if already claimed.
- [ ] `releaseTask(taskDir: string): void` — If status is "in_progress", reset to "pending" and clear worker_id.
- [ ] `promoteNextTodoToPending(): string | null` — Scan task dirs, find highest-priority "todo" task, atomically promote to "pending" using `.promote.lock`. Return task dir path or null.
- [ ] `readDesiredWorkers(): number` — Read from `$REPO_ROOT/.opencode/pipeline/monitor-workers` config file. Default to `FOUNDRY_WORKERS` env or 1.
- [ ] `writeDesiredWorkers(count: number): void` — Write to config file.
- [ ] `cancelInProgressTasks(): void` — Scan all task dirs, cancel orphaned in-progress tasks (mark completed if all agents done, cancelled otherwise).

**Validation:** `vitest run --reporter=verbose` — all existing tests pass + new tests for claim/promote/cancel.

### Task 1.2: Write tests for task claiming functions

- [ ] Create `monitor/src/__tests__/task-claiming.test.ts`
- [ ] Test: `claimTask` succeeds on pending task, sets worker_id and claimed_at
- [ ] Test: `claimTask` fails on non-pending task (returns false)
- [ ] Test: `claimTask` is atomic — concurrent claims on same task, only one succeeds
- [ ] Test: `releaseTask` resets in_progress to pending
- [ ] Test: `promoteNextTodoToPending` promotes highest-priority todo
- [ ] Test: `promoteNextTodoToPending` returns null when pending task already exists
- [ ] Test: `cancelInProgressTasks` marks completed when all agents done
- [ ] Test: `cancelInProgressTasks` marks cancelled when agents still pending

**Validation:** `vitest run src/__tests__/task-claiming.test.ts` — all pass.

---

## Phase 2: Git Worktree Helpers

### Task 2.1: Add worktree lifecycle functions to git.ts

Extend `monitor/src/infra/git.ts`:

- [ ] `getMainBranch(cwd?: string): string` — Detect main branch from `refs/remotes/origin/HEAD`, fallback to "main".
- [ ] `createWorktreeFromMain(workerId: string, repoRoot: string): string` — Create or reuse worktree at `.pipeline-worktrees/<workerId>`. If exists and valid, reset to origin/main. If stale, remove and recreate. Fallback chain: `origin/main` → local main → detached HEAD.
- [ ] `cleanupWorktree(workerId: string, repoRoot: string): void` — Remove worktree (force) + prune.

**Validation:** Existing git.ts tests pass. Manual test: create/cleanup worktree in dev environment.

### Task 2.2: Write tests for worktree helpers

- [ ] Create `monitor/src/__tests__/git-worktree.test.ts`
- [ ] Test: `getMainBranch` returns branch name
- [ ] Test: `createWorktreeFromMain` creates new worktree
- [ ] Test: `createWorktreeFromMain` reuses existing valid worktree
- [ ] Test: `cleanupWorktree` removes worktree directory

**Validation:** `vitest run src/__tests__/git-worktree.test.ts` — all pass.

---

## Phase 3: WorkerPool Implementation

### Task 3.1: Create batch.ts with WorkerPool class

Create `monitor/src/cli/batch.ts`:

- [ ] `WorkerPool` class with constructor accepting `{ repoRoot, tasksRoot, workerCount, watchInterval, stopOnFailure }`
- [ ] `WorkerPool.start()` — Spawn initial workers, register signal handlers
- [ ] `WorkerPool.shutdown()` — Graceful shutdown: wait for running workers (30s timeout), cleanup worktrees, cancel orphans, release batch lock
- [ ] `WorkerPool.spawnWorkers(count)` — Spawn workers up to desired count, skip already-running
- [ ] `WorkerPool.reapFinishedWorkers()` — Check worker promises, remove finished from tracking map
- [ ] `WorkerPool.scaleWorkers(desired)` — Scale up (spawn) or down (cancel excess workers)
- [ ] `workerLoop(workerId)` — Async function: claim task → create worktree (if multi-worker) → runPipeline → promote next todo → loop
- [ ] Singleton batch lock: acquire on start, release on shutdown
- [ ] Signal handlers: SIGTERM, SIGINT → `shutdown()`

**Validation:** TypeScript compiles without errors. Manual test with 1 worker on a test task.

### Task 3.2: Implement cmdBatch and cmdHeadless entry points

In `monitor/src/cli/batch.ts`:

- [ ] `cmdBatch(args: string[]): Promise<number>` — Parse args (`--workers`, `--watch`, `--watch-interval`, `--no-stop-on-failure`), create WorkerPool, run to completion or watch mode.
- [ ] `cmdHeadless(args: string[]): Promise<number>` — Check if already running (pgrep or batch lock), spawn detached child process with `--watch` flag, write PID to log.

**Validation:** `foundry batch --workers 1` runs and processes a pending task. `foundry headless` starts background processing.

### Task 3.3: Write tests for WorkerPool

- [ ] Create `monitor/src/__tests__/batch.test.ts`
- [ ] Test: WorkerPool spawns correct number of workers
- [ ] Test: WorkerPool reaps finished workers
- [ ] Test: WorkerPool scales down when desired count decreases
- [ ] Test: WorkerPool shutdown cancels in-progress tasks
- [ ] Test: cmdBatch parses arguments correctly
- [ ] Test: Singleton lock prevents duplicate batch instances

**Validation:** `vitest run src/__tests__/batch.test.ts` — all pass.

---

## Phase 4: CLI Integration

### Task 4.1: Update foundry.ts to use TS batch/headless

Modify `monitor/src/cli/foundry.ts`:

- [ ] Import `cmdBatch` and `cmdHeadless` from `./batch.js`
- [ ] Replace `case "batch": exitCode = runBashLib("foundry-batch.sh", args)` with `exitCode = await cmdBatch(args)`
- [ ] Replace `case "headless"` / `case "start"` nohup bash block with `exitCode = await cmdHeadless(args)`
- [ ] Replace `case "stop"` pkill bash with TS-native stop (read batch lock PID, send SIGTERM)
- [ ] Keep `runBashLib` function for remaining bash commands (retry, stats, cleanup, setup, e2e)

**Validation:** `foundry batch --help` shows help. `foundry batch --workers 2` processes tasks. `foundry headless` starts background. `foundry stop` stops it.

### Task 4.2: Update supervisor.ts worker management

Modify `monitor/src/cli/supervisor.ts`:

- [ ] Replace `workersAlive()` bash pgrep with batch lock file check
- [ ] Replace `startWorkers()` bash exec with `cmdHeadless([])` call
- [ ] Ensure supervisor can detect and restart TS-based headless workers

**Validation:** `foundry supervisor "test task" --poll 30` monitors and restarts workers correctly.

---

## Phase 5: Deprecation & Cleanup

### Task 5.1: Mark bash batch as deprecated

- [ ] Add deprecation comment to top of `lib/foundry-batch.sh`
- [ ] Add deprecation comment to worker functions in `lib/foundry-common.sh`
- [ ] Update `agentic-development/MIGRATION.md` with migration notes

**Validation:** No functional changes — documentation only.

---

## Dependency Order

```
Task 1.1 → Task 1.2 → Task 3.1
Task 2.1 → Task 2.2 → Task 3.1
Task 3.1 → Task 3.2 → Task 3.3 → Task 4.1 → Task 4.2 → Task 5.1
```

## Estimated Effort

| Phase | Tasks | Estimated Lines | Complexity |
|-------|-------|----------------|------------|
| Phase 1 | 1.1, 1.2 | ~200 | Medium |
| Phase 2 | 2.1, 2.2 | ~100 | Low |
| Phase 3 | 3.1, 3.2, 3.3 | ~400 | High |
| Phase 4 | 4.1, 4.2 | ~80 | Low |
| Phase 5 | 5.1 | ~20 | Low |
| **Total** | **10 tasks** | **~800** | **Medium-High** |
