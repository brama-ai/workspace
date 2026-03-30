# Foundry

Foundry is the sequential, queue-driven runtime for task execution. The public CLI is [`agentic-development/foundry`](/Users/nmdimas/work/brama-workspace/agentic-development/foundry).

## Overview

Foundry uses task directories as its queue and state store:

```text
tasks/<slug>--foundry/
  task.md
  handoff.md
  state.json
  events.jsonl
  summary.md
  meta.json
  artifacts/
```

Execution flow:

```text
task.md -> foundry -> foundry-run.sh -> agent chain -> summary.md
```

The queue is not a separate service. The queue is the set of `tasks/*--foundry/` directories whose state is `pending`.

## Quick Start

### Setup

```bash
./agentic-development/foundry setup
make builder-setup
```

### Open the Monitor

```bash
./agentic-development/foundry
```

### Check Status

```bash
./agentic-development/foundry status
```

### Run a Task Immediately

```bash
./agentic-development/foundry run "Add streaming support to A2A gateway"
./agentic-development/foundry run --task-file /absolute/path/to/task.md
```

### Start Queue Processing in Background

```bash
./agentic-development/foundry headless
```

This starts the Foundry batch watcher in the background and keeps polling the shared [`tasks/`](/Users/nmdimas/work/brama-workspace/tasks) root for pending Foundry tasks.

Stop it with:

```bash
./agentic-development/foundry stop
```

### Run E2E and Create Fix Tasks

Use `autotest` for the standard E2E to Foundry flow. It runs E2E, parses the report, and creates up to `N` bug-fix tasks in `tasks/*--foundry/`.

```bash
# Smoke suite, create up to 3 tasks, then start Foundry
./agentic-development/foundry autotest 3 --smoke --start

# Full suite, create up to 10 tasks, then start Foundry
./agentic-development/foundry autotest -n 10 --start

# Reuse an existing report without rerunning E2E
./agentic-development/foundry autotest 5 --from-report .opencode/pipeline/reports/e2e-autofix-20260324_154309.json
```

Behavior:

- positional `N` and `-n N` both set the maximum number of tasks to create
- `--smoke` limits the run to smoke-tagged E2E scenarios
- `--start` hands newly created tasks to background Foundry processing
- `--from-report` parses a saved Codecept JSON report and skips the E2E run entirely

## Creating Tasks

### Immediate mode

Use `run` when you want Foundry to materialize the task directory and start right away:

```bash
./agentic-development/foundry run --task-file /absolute/path/to/task.md
```

### Queue-first mode (manual)

Use this when you want a pool of pending tasks that background processing will consume later:

```bash
# Method 1: Manual directory creation
mkdir -p tasks/add-streaming-support--foundry/artifacts
cat > tasks/add-streaming-support--foundry/task.md <<EOF
# Add streaming support

Task description here...
EOF
```

If `state.json` does not exist yet, Foundry treats the task as `pending`.

**Note**: The directory name must follow the pattern `<slug>--foundry`. Task files created this way will be picked up by `./agentic-development/foundry headless` or `batch` commands.

## Task Pool Semantics

Foundry's task pool lives at the repository root:

```text
tasks/
```

Relevant directories for Foundry are:

```text
tasks/*--foundry/
```

Each task directory is one unit of work. `state.json` decides whether it is:

- `pending` - Ready to be claimed by a worker
- `in_progress` - Currently executing
- `completed` - Finished successfully
- `failed` - Failed permanently
- `suspended` - Paused mid-execution, can resume from checkpoint
- `stopped` - Halted before or during execution (see [Safe Start Protocol](./foundry-safe-start.md))
- `cancelled` - Cancelled by user or system

### Stopped Tasks

The `stopped` state indicates a task was halted due to safety constraints or user intervention. Unlike `failed`, stopped tasks can be resumed after fixing the underlying issue.

**Common stop reasons:**
- `dirty_default_workspace` - Main branch has uncommitted changes
- `base_resolution_failed` - Cannot resolve requested base reference
- `exclusive_scope_conflict` - Another task holds lock on required files
- `task_already_in_progress` - Task is already running elsewhere
- `stopped_by_user` - Manual stop by user

**Resume a stopped task:**
```bash
# Fix the issue (commit changes, resolve conflicts, etc.)
./agentic-development/foundry resume <task-slug>
```

**View stop details:**
```bash
# Check state.json for stop_reason and stop_details
cat tasks/<task-slug>--foundry/state.json | jq '.stop_reason, .stop_details'

# Read recovery instructions
cat tasks/<task-slug>--foundry/handoff.md
```

See [Safe Start Protocol](./foundry-safe-start.md) for complete documentation on preflight checks and stopped task handling.

## Background Workers

The runtime exposes worker-related flags and env vars:

```bash
FOUNDRY_WORKERS=2 ./agentic-development/foundry headless
./agentic-development/foundry batch --workers 2
```

Current implementation detail:

- the interface accepts a worker count
- the current batch runtime still processes serially
- only one active queue consumer should run in one checkout
- `.opencode/pipeline/.batch.lock` enforces that constraint

So today the practical throughput per checkout is one active Foundry task at a time.

## Main Commands

```bash
./agentic-development/foundry
./agentic-development/foundry status
./agentic-development/foundry headless
./agentic-development/foundry stop
./agentic-development/foundry autotest 5 --smoke --start
./agentic-development/foundry run --task-file /absolute/path/to/task.md
./agentic-development/foundry batch --watch
./agentic-development/foundry retry
./agentic-development/foundry stats
./agentic-development/foundry env-check
```

Useful targeted runs:

```bash
./agentic-development/foundry run --skip-architect "implement change add-a2a-streaming"
./agentic-development/foundry run --from coder "Continue implementing add-a2a-streaming"
./agentic-development/foundry run --only validator "Run PHPStan on core"
./agentic-development/foundry run --audit "Add agent feature X"
```

## Logs and Artifacts

Wrapper-level runtime logs:

- [`agentic-development/runtime/logs/foundry.log`](/Users/nmdimas/work/brama-workspace/agentic-development/runtime/logs/foundry.log)
- `agentic-development/runtime/logs/foundry-headless.log`

Execution logs and reports:

- `.opencode/pipeline/logs/`
- `.opencode/pipeline/reports/`

Per-task outputs:

- `tasks/<slug>--foundry/handoff.md`
- `tasks/<slug>--foundry/summary.md`
- `tasks/<slug>--foundry/artifacts/`

## Monitor and Admin UI

CLI monitor:

```bash
./agentic-development/foundry
```

Core admin UI, when core is running:

- `/admin/coder`
- `/admin/coder/create`
- `/admin/coder/{id}`

## Pipeline Profiles

Planner chooses the profile based on task analysis:

| Profile | Agents | Use Case |
|---------|--------|----------|
| `docs-only` | documenter → summarizer | Documentation only |
| `quality-gate` | coder → validator → summarizer | Fix lint/phpstan/cs |
| `tests-only` | coder → tester → summarizer | Write missing tests |
| `quick-fix` | coder → validator → summarizer | Typos, config, 1-3 files |
| `standard` | coder → validator → tester → summarizer | Normal feature |
| `standard+docs` | coder → validator → tester → documenter → summarizer | Feature + docs |
| `complex` | coder → validator → tester → summarizer | Multi-service, migrations |
| `complex+agent` | coder → auditor → validator → tester → summarizer | Agent modifications |
| `bugfix` | investigator → coder → validator → tester → summarizer | Bug fix (no spec change) |
| `bugfix+spec` | investigator → architect → coder → validator → tester → summarizer | Bug that changes spec |

> **Phase 8 — Deployer (opt-in):** Any profile can be followed by the deployer phase when `deploy: true` is set in task metadata and all stages pass. The deployer is not a profile itself — it is an optional final stage appended after the summarizer. See [deployer-agent.md](../../pipeline/en/deployer-agent.md).

## Environment Check

Before running the pipeline, check your environment:

```bash
./agentic-development/foundry env-check

# Check specific app
./agentic-development/foundry env-check --app core

# Multiple apps
./agentic-development/foundry env-check --app core --app knowledge-agent

# JSON output
./agentic-development/foundry env-check --json
```

Exit codes: `0` = OK, `1` = warnings, `2` = critical (pipeline should stop).

The Foundry runtime runs env-check automatically before task execution unless explicitly disabled.

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MONITOR_WORKERS` / `FOUNDRY_WORKERS` | `1` | Compatibility worker count; current runtime still consumes tasks serially |
| `MONITOR_AUTOSTART` | `true` | Monitor default for auto-start behavior |
| `MONITOR_LOG_RETENTION` | `7` | Days to keep logs |
| `PIPELINE_MAX_RETRIES` | `2` | Retries per agent |
| `PIPELINE_RETRY_DELAY` | `30` | Seconds between retries |

### Agent Timeouts

| Agent | Default | Env Variable |
|-------|---------|-------------|
| Investigator | 15 min | `PIPELINE_TIMEOUT_INVESTIGATOR` |
| Architect | 45 min | `PIPELINE_TIMEOUT_ARCHITECT` |
| Coder | 60 min | `PIPELINE_TIMEOUT_CODER` |
| Validator | 20 min | `PIPELINE_TIMEOUT_VALIDATOR` |
| Tester | 30 min | `PIPELINE_TIMEOUT_TESTER` |
| Documenter | 15 min | `PIPELINE_TIMEOUT_DOCUMENTER` |
| Auditor | 20 min | `PIPELINE_TIMEOUT_AUDITOR` |
| Summarizer | 15 min | `PIPELINE_TIMEOUT_SUMMARIZER` |
| Deployer | 20 min | `PIPELINE_TIMEOUT_DEPLOYER` |

### Model Configuration

Models are configured in `.opencode/agents.yaml`:

```bash
# Show current config
./agentic-development/agents-config.sh show

# Change model for an agent
./agentic-development/agents-config.sh set coder claude-opus-4-20250514

# Switch strategy
./agentic-development/agents-config.sh strategy free_only

# Validate
./agentic-development/validate-config.sh
```

## Output

Each Foundry run produces:

- Git branch: `pipeline/<task-slug>` — created in root repo **and all sub-project repos** (`brama-core/`, `brama-website/`, etc.)
- Summary: `tasks/<slug>--foundry/summary.md`
- Handoff: `tasks/<slug>--foundry/handoff.md`
- State: `tasks/<slug>--foundry/state.json`
- Events: `tasks/<slug>--foundry/events.jsonl`
- Artifacts: `tasks/<slug>--foundry/artifacts/`
- Reports: `.opencode/pipeline/reports/`

### Sub-Project Branch Management

Foundry automatically detects nested git repositories (sub-projects) under the workspace root and manages pipeline branches across all of them:

| Repo | Branch Created | Purpose |
|------|---------------|---------|
| Root (`brama-workspace/`) | `pipeline/<task-slug>` | Workspace-level changes (compose, scripts, config) |
| `brama-core/` | `pipeline/<task-slug>` | Product code changes |
| `brama-website/` | `pipeline/<task-slug>` | Website changes |

**Branch creation rules:**
- Branch is created in all sub-projects that have a clean working tree
- Sub-projects with uncommitted changes are skipped (branch created only after manual cleanup)
- The pipeline branch is checked out in each clean sub-project before agents start

**TUI display:**
- `branchExists` checks all repos (root + sub-projects)
- Shows branch status per sub-project in task detail view

## Make Targets

```bash
make pipeline TASK="Add feature X"      # Run single task
make pipeline-batch  # Batch run
make builder-setup                       # Legacy alias for initial setup
```
