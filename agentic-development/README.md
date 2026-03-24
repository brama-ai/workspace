# Agentic Development Runtime

`agentic-development/` now exposes only two public entrypoints:

- `./agentic-development/foundry.sh`
- `./agentic-development/ultraworks.sh`

Everything else under [`lib/`](/Users/nmdimas/work/brama-workspace/agentic-development/lib) is internal runtime code.

## Runtime Layout

Shared runtime state lives in two places:

```text
agentic-development/
  foundry.sh
  ultraworks.sh
  lib/
  runtime/
    .gitkeep
    logs/
      foundry.log
      ultraworks.log

tasks/
  <slug>--foundry/
    task.md
    handoff.md
    state.json
    events.jsonl
    summary.md
    meta.json
    artifacts/
  <slug>--ultraworks/
    task.md
    handoff.md
    state.json
    events.jsonl
    summary.md
    meta.json
    artifacts/
```

Meaning:

- `tasks/` is the task pool and the source of truth for task state.
- `agentic-development/runtime/logs/` stores wrapper-level logs for `foundry.sh` and `ultraworks.sh`.
- `.opencode/pipeline/` still exists as transient runtime scratch space for logs, reports, handoff symlinks, and live execution artifacts.

## Foundry

Foundry is the queue-driven sequential runtime.

### Main Commands

```bash
# Open monitor/menu
./agentic-development/foundry.sh

# One-shot status
./agentic-development/foundry.sh status

# Run one task immediately
./agentic-development/foundry.sh run "Add streaming support to A2A gateway"
./agentic-development/foundry.sh run --task-file /absolute/path/to/task.md

# Start background queue processing
./agentic-development/foundry.sh headless

# Stop background queue processing
./agentic-development/foundry.sh stop

# Retry failed tasks from the queue
./agentic-development/foundry.sh retry

# Show stats
./agentic-development/foundry.sh stats

# Check environment
./agentic-development/foundry.sh env-check
```

### How Foundry Task Pool Works

Foundry does not use a separate database-backed queue. The queue is simply the set of task directories in [`tasks/`](/Users/nmdimas/work/brama-workspace/tasks) whose workflow is `foundry` and whose `state.json` status is `pending`.

In practice, the Foundry task pool is:

```text
tasks/*--foundry/
```

Each directory is one queued or completed task.

### How to Create Foundry Tasks

There are two supported modes:

1. Immediate execution:

```bash
./agentic-development/foundry.sh run --task-file /absolute/path/to/task.md
```

This creates `tasks/<slug>--foundry/` automatically and starts the pipeline right away.

2. Queue-first execution:

Create a task directory manually, then let `headless` or `batch` consume it:

```bash
mkdir -p tasks/add-streaming-support--foundry
cp /absolute/path/to/task.md tasks/add-streaming-support--foundry/task.md
```

`state.json` may be absent initially. Foundry treats such a task as `pending` and materializes the rest of the runtime files when it starts processing it.

### Background Mode

Start the queue worker:

```bash
./agentic-development/foundry.sh headless
```

What it does:

- starts `lib/foundry-batch.sh` with `--watch`
- keeps polling [`tasks/`](/Users/nmdimas/work/brama-workspace/tasks) for `pending` Foundry tasks
- processes them one by one
- writes wrapper logs to [`agentic-development/runtime/logs/foundry.log`](/Users/nmdimas/work/brama-workspace/agentic-development/runtime/logs/foundry.log)
- writes batch stdout/stderr to `agentic-development/runtime/logs/foundry-headless.log`

Stop it with:

```bash
./agentic-development/foundry.sh stop
```

### Multiple Workers and Concurrency

Foundry currently exposes a worker count for compatibility:

```bash
FOUNDRY_WORKERS=2 ./agentic-development/foundry.sh headless
./agentic-development/foundry.sh batch --workers 2
```

Current behavior:

- the interface accepts `workers`
- the current runtime still processes serially
- only one active batch consumer should run per repository checkout
- `lib/foundry-batch.sh` uses a batch lock under `.opencode/pipeline/.batch.lock`

So today, in one checkout, Foundry concurrency is effectively:

- `1` queue consumer
- `1` active task at a time

If true parallel Foundry execution is needed, it should be isolated via separate git worktrees or future worker support. The current docs should be read as compatibility-oriented, not as actual multi-worker throughput.

### Foundry Monitor

Open it with:

```bash
./agentic-development/foundry.sh
```

Current menu actions:

- start background workers
- stop workers
- retry failed tasks
- show status
- open latest summary

### Foundry Outputs

For a Foundry task `tasks/add-streaming-support--foundry/`:

- prompt: `task.md`
- human handoff: `handoff.md`
- machine state: `state.json`
- event history: `events.jsonl`
- final summary: `summary.md`
- runtime artifacts: `artifacts/`

## Ultraworks

Ultraworks is the OpenCode-native orchestrator. It is monitor-first like Foundry, but its execution model is different: each launched task gets its own tmux session, branch, and git worktree.

### Main Commands

```bash
# Open menu/monitor
./agentic-development/ultraworks.sh

# One-shot status
./agentic-development/ultraworks.sh status

# Interactive launch in tmux
./agentic-development/ultraworks.sh launch "Fix auth bug in admin panel"

# Headless run
./agentic-development/ultraworks.sh headless "Fix auth bug in admin panel"

# Live watch mode
./agentic-development/ultraworks.sh watch

# Attach to latest tracked session
./agentic-development/ultraworks.sh attach

# Show logs
./agentic-development/ultraworks.sh logs
```

### Background and Parallel Execution

Unlike Foundry, Ultraworks is designed for isolated parallel runs.

Each `launch` or `headless` task creates:

- a task directory in [`tasks/`](/Users/nmdimas/work/brama-workspace/tasks)
- a tmux session or tracked headless run
- a dedicated branch `pipeline/<slug>` with collision-safe suffixes
- a dedicated worktree under `.pipeline-worktrees/`

That means multiple Ultraworks tasks can run at the same time without sharing the same task directory or worktree.

Recommended practical concurrency is an operational guideline, not a hard runtime limit:

- start with `2-3` concurrent Ultraworks tasks
- increase only if the host, provider limits, and repo size handle it cleanly

### Ultraworks Outputs

For a task `tasks/fix-auth-bug--ultraworks/`:

- prompt: `task.md`
- handoff/journal: `handoff.md`
- current state: `state.json`
- event stream: `events.jsonl`
- final summary: `summary.md`
- metadata: `meta.json`

## Logs

Wrapper-level logs:

- [`agentic-development/runtime/logs/foundry.log`](/Users/nmdimas/work/brama-workspace/agentic-development/runtime/logs/foundry.log)
- `agentic-development/runtime/logs/ultraworks.log`

Execution-level logs and reports:

- `.opencode/pipeline/logs/`
- `.opencode/pipeline/reports/`

## Setup

```bash
./agentic-development/foundry.sh setup
```

This prepares task/runtime directories and validates supporting dependencies.

## Compatibility Notes

- `make builder-setup` remains as a legacy alias.
- Public operational entrypoints are only `foundry.sh` and `ultraworks.sh`.
- Scripts under `agentic-development/lib/` are implementation details and should not be treated as stable CLI.
