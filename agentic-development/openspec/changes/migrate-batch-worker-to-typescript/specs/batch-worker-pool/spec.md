# Spec: Batch Worker Pool

**Capability:** `batch-worker-pool`
**Change:** `migrate-batch-worker-to-typescript`

## ADDED Requirements

### Task Claiming

#### Scenario: Worker claims a pending task atomically
Given: A task directory with `state.json` status = "pending"
And: Worker "worker-1" attempts to claim the task
When: `claimTask(taskDir, "worker-1")` is called
Then: Returns `true`
And: `state.json` status = "in_progress"
And: `state.json` worker_id = "worker-1"
And: `state.json` claimed_at is set to current ISO timestamp
And: `.claim.lock` file is created and removed after state write

#### Scenario: Worker cannot claim an already-claimed task
Given: A task directory with `state.json` status = "in_progress"
And: Worker "worker-2" attempts to claim the task
When: `claimTask(taskDir, "worker-2")` is called
Then: Returns `false`
And: `state.json` is unchanged

#### Scenario: Concurrent claim attempts — only one succeeds
Given: A task directory with `state.json` status = "pending"
And: Workers "worker-1" and "worker-2" attempt to claim simultaneously
When: Both call `claimTask(taskDir, workerId)` concurrently
Then: Exactly one returns `true`
And: The other returns `false`
And: `state.json` contains exactly one worker_id

#### Scenario: Release a claimed task
Given: A task directory with `state.json` status = "in_progress" and worker_id = "worker-1"
When: `releaseTask(taskDir)` is called
Then: `state.json` status = "pending"
And: `state.json` worker_id is cleared

### Todo-to-Pending Promotion

#### Scenario: Promote highest-priority todo to pending
Given: Three task directories with status = "todo" and priorities 1, 3, 2
And: No task has status = "pending"
When: `promoteNextTodoToPending()` is called
Then: Returns the task directory with priority 3
And: That task's `state.json` status = "pending"
And: Other tasks remain status = "todo"

#### Scenario: No promotion when pending task exists
Given: One task with status = "pending"
And: One task with status = "todo"
When: `promoteNextTodoToPending()` is called
Then: Returns `null`
And: No state changes

#### Scenario: No promotion when no todo tasks exist
Given: All tasks have status = "completed" or "failed"
When: `promoteNextTodoToPending()` is called
Then: Returns `null`

### Worker Pool Lifecycle

#### Scenario: WorkerPool starts with configured worker count
Given: WorkerPool configured with `workerCount: 3`
When: `pool.start()` is called
Then: 3 worker loops are spawned
And: Each worker has a unique ID ("worker-1", "worker-2", "worker-3")
And: Batch singleton lock is acquired

#### Scenario: WorkerPool rejects start when another instance is running
Given: Batch singleton lock file exists with a live PID
When: `pool.start()` is called
Then: Throws error "Another Foundry batch is already running"
And: No workers are spawned

#### Scenario: WorkerPool reaps finished workers
Given: WorkerPool with 2 running workers
And: Worker "worker-1" finishes its task
When: `pool.reapFinishedWorkers()` is called
Then: "worker-1" is removed from the active workers map
And: "worker-2" remains active

#### Scenario: WorkerPool scales down when desired count decreases
Given: WorkerPool with 3 running workers
And: Desired worker count changes to 1
When: `pool.scaleWorkers(1)` is called
Then: 2 excess workers are signaled to stop after their current task
And: 1 worker continues running

#### Scenario: WorkerPool scales up when desired count increases
Given: WorkerPool with 1 running worker
And: Desired worker count changes to 3
When: `pool.scaleWorkers(3)` is called
Then: 2 new workers are spawned
And: Total active workers = 3

### Worker Loop

#### Scenario: Worker processes a task with single worker (no worktree)
Given: WorkerPool with `workerCount: 1`
And: A pending task exists
When: Worker claims and processes the task
Then: `runPipeline()` is called with `repoRoot` = main repository root
And: No git worktree is created
And: After completion, worker attempts to claim next task

#### Scenario: Worker processes a task with multiple workers (worktree)
Given: WorkerPool with `workerCount: 2`
And: A pending task exists
When: Worker "worker-1" claims and processes the task
Then: A git worktree is created at `.pipeline-worktrees/worker-1`
And: `runPipeline()` is called with `repoRoot` = worktree path
And: After completion, worker attempts to claim next task

#### Scenario: Worker handles task failure with stop-on-failure
Given: WorkerPool with `stopOnFailure: true`
And: A pending task exists
When: Worker processes the task and `runPipeline()` returns `success: false`
Then: Worker logs the failure
And: Worker exits its loop (stops claiming new tasks)
And: Next todo is promoted to pending

#### Scenario: Worker handles task failure without stop-on-failure
Given: WorkerPool with `stopOnFailure: false`
And: A pending task exists
When: Worker processes the task and `runPipeline()` returns `success: false`
Then: Worker logs the failure
And: Worker releases the task
And: Worker continues to claim next task

### Graceful Shutdown

#### Scenario: SIGTERM triggers graceful shutdown
Given: WorkerPool with 2 running workers processing tasks
When: Process receives SIGTERM
Then: `pool.shutdown()` is called
And: Workers are allowed up to 30 seconds to finish current task
And: All git worktrees are cleaned up
And: Orphaned in-progress tasks are cancelled
And: Batch singleton lock is released
And: Process exits with code 0

#### Scenario: SIGINT triggers graceful shutdown
Given: WorkerPool with running workers
When: Process receives SIGINT
Then: Same behavior as SIGTERM

#### Scenario: Shutdown cancels in-progress tasks correctly
Given: Task A is in_progress with all agents completed
And: Task B is in_progress with agents still pending
When: `cancelInProgressTasks()` is called
Then: Task A status = "completed" (all agents done)
And: Task B status = "cancelled" (mid-pipeline)

### Watch Mode

#### Scenario: Watch mode polls for new tasks
Given: WorkerPool in watch mode with `watchInterval: 15000`
And: No pending tasks initially
When: A new task with status = "todo" appears
Then: Within 15 seconds, the task is promoted to "pending"
And: A worker claims and processes it

#### Scenario: Watch mode reads dynamic worker count
Given: WorkerPool in watch mode with initial `workerCount: 1`
When: `$REPO_ROOT/.opencode/pipeline/monitor-workers` is written with value "3"
Then: On next poll cycle, WorkerPool scales to 3 workers

### CLI Entry Points

#### Scenario: `foundry batch` runs to completion
Given: Pending tasks exist
When: `foundry batch --workers 2` is executed
Then: WorkerPool processes all pending tasks with 2 workers
And: Exits with code 0 on success, 1 on failure

#### Scenario: `foundry batch --watch` enters watch mode
Given: No pending tasks
When: `foundry batch --watch --watch-interval 10 --workers 2` is executed
Then: WorkerPool enters watch mode
And: Polls every 10 seconds for new tasks
And: Runs until SIGTERM/SIGINT

#### Scenario: `foundry headless` starts background processing
Given: No headless instance is running
When: `foundry headless` is executed
Then: A detached child process is spawned with `--watch` flag
And: PID is written to runtime log
And: Console shows "Foundry headless started (workers=N)"

#### Scenario: `foundry headless` detects existing instance
Given: A headless instance is already running (batch lock held)
When: `foundry headless` is executed
Then: Console shows "Foundry headless already running"
And: No new process is spawned

#### Scenario: `foundry stop` terminates headless workers
Given: A headless instance is running
When: `foundry stop` is executed
Then: SIGTERM is sent to the batch process (read PID from lock file)
And: Console shows "Foundry headless workers stopped"

## MODIFIED Requirements

### task-state-v2.ts Interface

#### Scenario: TaskState includes worker_id field
Given: The `TaskState` interface in `task-state-v2.ts`
When: A task is claimed by a worker
Then: `state.worker_id` contains the worker ID string
And: `state.claimed_at` contains the ISO timestamp of claiming

_Note: `worker_id` already exists in the interface. `claimed_at` is added as optional field._

### foundry.ts CLI Routing

#### Scenario: `batch` command routes to TypeScript implementation
Given: The `foundry.ts` CLI switch statement
When: Command is "batch"
Then: `cmdBatch(args)` is called (from `./batch.js`)
And: `runBashLib("foundry-batch.sh", args)` is NOT called

#### Scenario: `headless` command routes to TypeScript implementation
Given: The `foundry.ts` CLI switch statement
When: Command is "headless" or "start"
Then: `cmdHeadless(args)` is called (from `./batch.js`)
And: No `nohup` bash subprocess is spawned

#### Scenario: `stop` command uses lock-file based termination
Given: The `foundry.ts` CLI switch statement
When: Command is "stop"
Then: Batch lock file is read for PID
And: SIGTERM is sent to that PID
And: `pkill -f 'foundry-batch\\.sh'` is NOT called

## REMOVED Requirements

#### Scenario: Direct bash delegation for batch command
Removed: `case "batch": exitCode = runBashLib("foundry-batch.sh", args)`
Reason: Replaced by native TypeScript `cmdBatch()` implementation

#### Scenario: nohup bash for headless command
Removed: `execSync(nohup foundry-batch.sh --watch ...)` in headless case
Reason: Replaced by native TypeScript `cmdHeadless()` with detached child process

#### Scenario: pkill bash for stop command
Removed: `execSync("pkill -f 'foundry-batch\\.sh'")` in stop case
Reason: Replaced by lock-file PID-based SIGTERM
