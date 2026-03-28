# Pipeline Task State

This document describes the task directory contract, file roles, and state model for the Foundry pipeline.

## Task Directory Layout

Each task run lives under:

```
tasks/<task-slug>--foundry/
```

Every task directory contains:

```
task.md          — original task prompt (immutable after creation)
handoff.md       — readable inter-agent journal (task-scoped)
state.json       — canonical machine-readable state
events.jsonl     — append-only event stream
summary.md       — final summary artifact (required for archival)
meta.json        — immutable metadata (workflow, branch, run_id, etc.)
artifacts/
  telemetry/
  checkpoint.json
  u-<agent>/
    result.json
```

## File Roles

### `task.md`
- Original task prompt or normalized task description
- **Immutable after creation** — MUST NOT be deleted or modified by retry, cleanup, or archival
- Pipeline refuses to start if `task.md` is missing or empty

### `handoff.md`
- Readable inter-agent journal
- **Task-scoped** — agents read/write directly from `<task_dir>/handoff.md`
- No global symlink at `.opencode/pipeline/handoff.md` (removed to prevent race conditions)

### `state.json`
- Canonical machine-readable state
- Source of truth for monitor, status, and resume
- Schema: `task_id`, `workflow`, `status`, `current_step`, `attempt`, `agents[]`, `updated_at`

### `events.jsonl`
- Append-only event stream for history and diagnostics
- Each line is a JSON object: `{"timestamp":"...","type":"...","message":"..."}`

### `summary.md`
- Final or best-effort summary artifact for that specific task
- **Archival gate** — task MUST NOT be archived if `summary.md` is empty or missing

### `meta.json`
- Immutable or slow-changing metadata
- Fields: `workflow`, `task_slug`, `created_at`, `branch_name`, `worktree_path`, `profile`, `run_id`, `resumed_from`

## State Model

### Task Statuses

| Status | Description |
|--------|-------------|
| `pending` | Task queued, not yet started |
| `in_progress` | Pipeline actively running |
| `waiting_answer` | Agent waiting for human input (HITL) |
| `completed` | Pipeline finished successfully |
| `failed` | Pipeline failed at an agent |
| `cancelled` | Task cancelled by operator |
| `abandoned` | Task abandoned (no longer relevant) |
| `stopped` | Task stopped by operator |

### Agent History Model

The `agents[]` array in `state.json` preserves full history across retries:

```json
{
  "agents": [
    {
      "agent": "u-coder",
      "attempt": 1,
      "status": "failed",
      "model": "anthropic/claude-sonnet-4-6",
      "duration_seconds": 120,
      "started_at": "2026-03-28T10:00:00Z",
      "completed_at": "2026-03-28T10:02:00Z"
    },
    {
      "agent": "u-coder",
      "attempt": 2,
      "status": "done",
      "model": "anthropic/claude-sonnet-4-6",
      "duration_seconds": 95,
      "started_at": "2026-03-28T10:05:00Z",
      "completed_at": "2026-03-28T10:06:35Z"
    }
  ]
}
```

- Each agent entry is keyed by `(agent, attempt)`
- On retry, new entries are **appended** with the new attempt number
- Queries for "current agent status" filter by `attempt == state.attempt`

## Atomic Directory Init

Task directories are created atomically:

1. Write all files to a temp dir: `$PIPELINE_TASKS_ROOT/.tmp.XXXXXX`
2. `mv` temp dir to final path (atomic on same filesystem)
3. SIGINT/SIGTERM trap cleans up `.tmp.*` dirs on interrupt
4. On startup, any leftover `.tmp.*` dirs are removed

## Archive Guard

Tasks can only be archived when `summary.md` is non-empty:

- Bash cleanup: `foundry-cleanup.sh` checks `[[ -s "$task_dir/summary.md" ]]`
- TypeScript monitor: `archiveTask()` checks `statSync(summaryPath).size > 0`
- If guard fails: `archive_blocked` event emitted, task remains in `tasks/`

## Validation Scenarios

### Ghost Dir Scenario (6.1)
- Interrupt `foundry run` mid-init → no ghost directory remains in `tasks/`
- Mechanism: atomic `mv` from `.tmp.*` dir; SIGINT trap cleans up incomplete dirs

### Retry Scenario (7.1)
- Agent fails, `task.md` still present after retry → resume works
- Mechanism: `retry_task()` asserts `[[ -s "$task_dir/task.md" ]]` before proceeding

### Concurrent Runs Scenario (8.1)
- Two pipeline runs active → no shared `handoff.md` cross-contamination
- Mechanism: each task uses `$TASK_DIR/handoff.md` directly; no global symlink

### Archive Guard Scenario (10.1)
- Task with empty `summary.md` → not archived, reported to operator
- Mechanism: both Bash and TypeScript check `summary.md` size before archiving
