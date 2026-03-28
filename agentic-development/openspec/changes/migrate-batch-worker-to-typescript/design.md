# Design: Migrate Batch Worker Pool to TypeScript

## Problem

The Foundry batch worker pool is split across two bash scripts:

1. **`foundry-batch.sh`** (~298 lines) — Orchestrates parallel workers: argument parsing, singleton lock, worker spawning/reaping, watch mode loop, cleanup on exit.
2. **`foundry-common.sh`** (worker-related functions, ~250 lines) — Atomic task claiming (`flock`), git worktree lifecycle, worker listing/counting, desired-workers config, todo-to-pending promotion, in-progress task cancellation.

The TS CLI (`foundry.ts`) delegates to these via `runBashLib("foundry-batch.sh", args)` for `batch` and `execSync(nohup foundry-batch.sh --watch ...)` for `headless`. This creates a process boundary where:

- State mutations happen in bash (raw `jq`) instead of through `task-state-v2.ts`
- Errors are communicated as exit codes, not typed results
- No structured telemetry flows back to the TS layer
- Worker health is invisible to the supervisor

## Approach

### Architecture: WorkerPool Class

Create a single `WorkerPool` class in `monitor/src/cli/batch.ts` that encapsulates all worker lifecycle management:

```
┌─────────────────────────────────────────────────────┐
│  foundry.ts CLI                                      │
│  ┌──────────┐  ┌──────────────┐                     │
│  │ cmdBatch  │  │ cmdHeadless  │                     │
│  └─────┬────┘  └──────┬───────┘                     │
│        │               │                             │
│        └───────┬───────┘                             │
│                ▼                                     │
│  ┌─────────────────────────────┐                     │
│  │       WorkerPool            │                     │
│  │  ┌───────────────────────┐  │                     │
│  │  │ spawn / reap / scale  │  │                     │
│  │  │ claimNextTask()       │  │                     │
│  │  │ promoteNextTodo()     │  │                     │
│  │  │ gracefulShutdown()    │  │                     │
│  │  └───────────┬───────────┘  │                     │
│  └──────────────┼──────────────┘                     │
│                 │                                     │
│    ┌────────────┼────────────┐                       │
│    ▼            ▼            ▼                       │
│  Worker 1    Worker 2    Worker N                    │
│  (async)     (async)     (async)                    │
│    │            │            │                       │
│    ▼            ▼            ▼                       │
│  runPipeline() runPipeline() runPipeline()          │
│  (runner.ts)   (runner.ts)   (runner.ts)            │
└─────────────────────────────────────────────────────┘
```

### Key Design Decisions

#### 1. Workers as Async Tasks (not child processes)

**Bash approach:** Each worker is a background subshell (`worker_loop "$wid" &`), tracked by PID.

**TS approach:** Each worker is an `async` function running in the same Node.js process, tracked by a `Map<string, WorkerHandle>`. The `runPipeline()` call is already async and handles agent execution via `child_process.spawn`.

**Rationale:** Node.js is single-threaded for JS execution but handles I/O concurrently. Since workers spend most time waiting for `opencode run` child processes (via `executor.ts`), async concurrency is sufficient. This avoids the complexity of managing child Node.js processes and simplifies state sharing.

**Trade-off:** All workers share the same event loop. A CPU-bound operation in one worker could block others. This is acceptable because:
- Workers delegate CPU-heavy work to `opencode run` child processes
- The TS layer only does I/O (file reads, state writes, process management)

#### 2. File-Based Locking for Task Claiming

**Bash approach:** Uses `flock -n 9` on a `.claim.lock` file with file descriptor redirection.

**TS approach:** Use atomic file operations for locking:

```typescript
// Option A: O_EXCL flag (atomic create-or-fail)
import { openSync, closeSync, constants } from "node:fs";

function acquireLock(lockPath: string): boolean {
  try {
    const fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    writeFileSync(lockPath, `${process.pid}\n`);
    closeSync(fd);
    return true;
  } catch {
    return false; // Lock already held
  }
}
```

**Rationale:** `O_CREAT | O_EXCL` is atomic on Linux/macOS — the kernel guarantees only one process can create the file. This matches `flock -n` semantics (non-blocking exclusive lock). No npm dependency needed.

**Important:** The lock must be compatible with bash `flock` during the transition period where both implementations may coexist. Since bash uses `flock` (advisory locks on file descriptors) and TS uses `O_EXCL` (filesystem-level), they operate on different mechanisms. During transition, only one implementation should be active at a time.

#### 3. Singleton Batch Lock

**Bash approach:** Writes PID to `.batch.lock`, checks if PID is alive via `/proc/<pid>/status`.

**TS approach:** Same pattern — write PID to `.batch.lock`, check liveness on startup:

```typescript
function acquireBatchLock(lockFile: string): boolean {
  if (existsSync(lockFile)) {
    const oldPid = parseInt(readFileSync(lockFile, "utf8").trim(), 10);
    if (oldPid && isProcessAlive(oldPid)) {
      return false; // Another instance running
    }
    // Stale lock — remove
    unlinkSync(lockFile);
  }
  writeFileSync(lockFile, `${process.pid}\n`);
  return true;
}
```

#### 4. Watch Mode (Headless)

**Bash approach:** Infinite loop with `sleep $WATCH_INTERVAL`, reads desired worker count from config file each iteration.

**TS approach:** `setInterval` with async handler:

```typescript
async startWatchMode(intervalMs: number): Promise<void> {
  this.watchTimer = setInterval(async () => {
    const desired = this.readDesiredWorkers();
    await this.scaleWorkers(desired);
    await this.promoteNextTodo();
    this.reapFinishedWorkers();
  }, intervalMs);
}
```

**Headless launch:** Instead of `nohup bash ... &`, the TS headless command will:
1. Fork a detached child process running the same Node.js entry point with `--watch` flag
2. Use `child_process.spawn` with `detached: true, stdio: 'ignore'` and `unref()`
3. Write PID to log for monitoring

#### 5. Git Worktree Management

**Bash approach:** `foundry_create_worktree()` creates worktrees under `.pipeline-worktrees/<worker-id>`.

**TS approach:** Extend `infra/git.ts` with a `createWorktreeFromMain()` function that:
1. Checks if worktree already exists and is valid
2. Resets to `origin/main` if reusing
3. Creates new worktree with `git worktree add -b pipeline-worker-<id>`
4. Falls back through same chain as bash (origin/main → local main → detached HEAD)

The existing `addWorktree()`, `removeWorktree()`, `pruneWorktrees()` in `git.ts` provide the primitives.

#### 6. Graceful Shutdown

**Bash approach:** `trap 'cleanup_all; release_lock' EXIT` — kills worker PIDs, cancels in-progress tasks.

**TS approach:**

```typescript
process.on("SIGTERM", () => this.shutdown());
process.on("SIGINT", () => this.shutdown());

async shutdown(): Promise<void> {
  this.shuttingDown = true;
  clearInterval(this.watchTimer);
  // Wait for running workers to finish current task (with timeout)
  await Promise.race([
    Promise.all(this.workers.values().map(w => w.promise)),
    sleep(30_000), // 30s grace period
  ]);
  // Cleanup worktrees
  for (const [id] of this.workers) {
    cleanupWorktree(id);
  }
  // Cancel orphaned in-progress tasks
  cancelInProgressTasks();
  releaseBatchLock();
}
```

#### 7. Task Claiming Integration with task-state-v2.ts

Add two new functions to `task-state-v2.ts`:

```typescript
export function claimTask(taskDir: string, workerId: string): boolean
export function promoteNextTodoToPending(): string | null
```

These replace the bash `foundry_claim_task()` and `foundry_promote_next_todo_to_pending()` with typed, testable implementations that use the same file-locking pattern.

## Alternatives Considered

### A. Worker Threads (node:worker_threads)

**Rejected.** Worker threads add complexity (message passing, shared memory) without benefit. Workers are I/O-bound (waiting for child processes), not CPU-bound. Async functions in the main thread are simpler and sufficient.

### B. npm `proper-lockfile` Package

**Rejected.** Adds an external dependency for a simple operation. `O_CREAT | O_EXCL` is sufficient and has zero dependencies. The `proper-lockfile` package also uses polling-based stale detection which is unnecessary for our use case.

### C. Gradual Migration (Feature Flag)

**Considered but deferred.** A `FOUNDRY_TS_BATCH=true` env var could toggle between bash and TS implementations. This adds complexity for a short transition period. Instead, the bash scripts are kept intact for manual rollback — the `foundry.ts` switch statement simply changes which function handles `batch` and `headless`.

### D. Separate Node.js Process per Worker

**Rejected.** Spawning separate Node.js processes per worker would mirror the bash approach but adds ~100ms startup overhead per worker and complicates state sharing. Since `runPipeline()` is already async and spawns `opencode run` as child processes, in-process async workers are more efficient.

## Component Interactions

### New File: `monitor/src/cli/batch.ts`

```
Exports:
  - cmdBatch(args: string[]): Promise<number>
  - cmdHeadless(args: string[]): Promise<number>
  - WorkerPool (class)

Imports from:
  - ../state/task-state-v2.ts  — claimTask, promoteNextTodo, setStateStatus, etc.
  - ../pipeline/runner.ts      — runPipeline, PipelineConfig
  - ../infra/git.ts            — createWorktreeFromMain, cleanupWorktree
  - ../state/events.ts         — emitEvent
  - ../lib/runtime-logger.ts   — rlog
```

### Modified: `monitor/src/cli/foundry.ts`

```diff
- case "batch":
-   exitCode = runBashLib("foundry-batch.sh", args);
-   break;
+ case "batch":
+   exitCode = await cmdBatch(args);
+   break;

- case "headless":
- case "start": {
-   // ... nohup bash ...
-   break;
- }
+ case "headless":
+ case "start":
+   exitCode = await cmdHeadless(args);
+   break;
```

### Modified: `monitor/src/state/task-state-v2.ts`

New exports:
- `claimTask(taskDir, workerId)` — Atomic claim with file lock
- `releaseTask(taskDir)` — Release claimed task back to pending
- `promoteNextTodoToPending()` — Priority-sorted todo→pending promotion
- `readDesiredWorkers()` — Read from `monitor-workers` config
- `writeDesiredWorkers(count)` — Write to `monitor-workers` config
- `cancelInProgressTasks()` — Cancel orphaned in-progress tasks

### Modified: `monitor/src/infra/git.ts`

New exports:
- `createWorktreeFromMain(workerId, repoRoot)` — Full worktree lifecycle (create/reuse/reset)
- `cleanupWorktree(workerId, repoRoot)` — Remove worktree + prune
- `getMainBranch(repoRoot)` — Detect main branch name

## Data Model

No schema changes. The migration uses the existing `state.json` format:

```json
{
  "task_id": "my-task--foundry",
  "workflow": "foundry",
  "status": "in_progress",
  "worker_id": "worker-1",
  "claimed_at": "2026-03-28T10:00:00Z",
  "updated_at": "2026-03-28T10:05:00Z",
  ...
}
```

The `worker_id` and `claimed_at` fields are already part of the bash state mutations and are preserved in the TS implementation.

## File Locking Protocol

The lock file protocol must be documented since it's the critical concurrency mechanism:

1. **Batch singleton lock** (`$REPO_ROOT/.opencode/pipeline/.batch.lock`)
   - Contains: PID of batch process
   - Acquired: On batch/headless start
   - Released: On exit (normal or signal)
   - Stale detection: Check `/proc/<pid>/status` or `process.kill(pid, 0)`

2. **Task claim lock** (`$TASK_DIR/.claim.lock`)
   - Created atomically with `O_CREAT | O_EXCL`
   - Contains: worker ID + timestamp
   - Held: During state.json status transition (pending → in_progress)
   - Released: After state.json write completes (unlink lock file)

3. **Todo promotion lock** (`$TASK_DIR/.promote.lock`)
   - Same pattern as claim lock
   - Prevents two workers from promoting different todos simultaneously
