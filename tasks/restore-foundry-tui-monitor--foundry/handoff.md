# Pipeline Handoff

- **Task**: <!-- priority: 1 -->
# Restore full TUI monitor for Foundry

## Problem

During the `builder/ → agentic-development/` restructure, the full-featured pipeline monitor TUI (1542 lines) was replaced with an 86-line simple menu (`foundry-monitor.sh`). The original TUI with auto-refresh, tab navigation, activity timeline, and worker monitoring was lost.

The original TUI is preserved at: `brama-core/.pipeline-worktrees/worker-1/builder/monitor/pipeline-monitor.sh`

## Goal

Adapt the original `pipeline-monitor.sh` TUI to work with the Foundry task model and place it at `agentic-development/lib/pipeline-monitor.sh`. The current `foundry-monitor.sh` (simple command menu) stays as-is — it becomes the fallback for non-interactive use.

`foundry.sh` (no args) should launch the full TUI monitor instead of the simple menu.

## Key adaptations needed

### 1. Task model: directory-based → state.json-based

**Old model** (pipeline-monitor.sh):
```
builder/tasks/todo/*.md
builder/tasks/in-progress/*.md
builder/tasks/done/*.md
builder/tasks/failed/*.md
builder/tasks/suspended/*.md
```

**New model** (Foundry):
```
tasks/<slug>--foundry/task.md       # task content
tasks/<slug>--foundry/state.json    # {"status":"pending|in_progress|completed|failed|suspended|cancelled"}
tasks/<slug>--foundry/summary.md    # summary after completion
tasks/<slug>--foundry/events.jsonl  # event log
tasks/<slug>--foundry/handoff.md    # handoff document
tasks/<slug>--foundry/artifacts/    # runtime artifacts
```

Use `foundry-common.sh` helpers: `foundry_list_task_dirs`, `foundry_task_counts`, `foundry_state_field`, `foundry_summary_file`.

### 2. Process detection

**Old**: `pgrep -f 'pipeline-batch.sh'`
**New**: `foundry_is_batch_running` from foundry-common.sh

### 3. Actions: use foundry.sh commands

**Old**: Direct calls to `pipeline-batch.sh`, manual `mv` between directories
**New**: Actions should delegate to `foundry.sh`:
- Start workers: `foundry.sh headless`
- Stop workers: `foundry.sh stop`
- Retry failed: `foundry.sh retry`
- Show stats: `foundry.sh stats`

### 4. Log/artifact paths

**Old**: `.opencode/pipeline/logs/`, worktree-based logs
**New**: `.opencode/pipeline/logs/` (same), plus per-task `tasks/<slug>--foundry/artifacts/`

### 5. Activity tab: events.jsonl

**Old**: Reads `events.log` from worktree with pipe-delimited format
**New**: Read `events.jsonl` from the active task directory. Each line is JSON with timestamp, type, and data fields. Adapt `render_logs_tab()` / `build_activity_data()` to parse JSONL.

### 6. Entry point wiring

In `foundry.sh`, change the `monitor` case:
```bash
monitor)
  runtime_log foundry "command=monitor"
  exec "$REPO_ROOT/agentic-development/lib/pipeline-monitor.sh" "$FOUNDRY_TASK_ROOT"
  ;;
```

### 7. Features to preserve from original TUI

- Flicker-free buffer rendering (`buf_reset/buf_line/buf_flush`)
- Auto-refresh every 3 seconds
- Tab navigation (Overview, Activity, Worker tabs)
- Arrow key + number key navigation
- Task selection with cursor
- Detail view (Enter) and log view (l)
- Progress bar
- Context-aware bottom menu
- Alternate screen buffer
- Color support with tput
- Priority management (+/-)
- Auto-start logic
- Log cleanup on startup
- Environment status line from env-report.json

### 8. Features to remove/simplify

- Worktree-based worker detection (Foundry is serial, no worktrees)
- Cost tracking stubs (already removed in original)
- OpenRouter balance query (already stubbed out)
- `stat -f%m` macOS-specific fallbacks (devcontainer is Linux-only)

## Files to create/modify

- `agentic-development/lib/pipeline-monitor.sh` (new — adapted TUI)
- `agentic-development/foundry.sh` (modify — monitor case points to pipeline-monitor.sh)

## Validation

- `./agentic-development/foundry.sh` opens full TUI with auto-refresh
- TUI shows 3+ pending/in-progress tasks from `tasks/*--foundry/`
- Tab switching works (1=Overview, 2=Activity)
- Arrow keys navigate task list
- `s` starts headless workers
- `k` stops workers
- `q` exits cleanly (restores terminal)
- Auto-refresh updates task states every 3 seconds without user input

## Reference

- Original TUI: `brama-core/.pipeline-worktrees/worker-1/builder/monitor/pipeline-monitor.sh`
- Foundry common helpers: `agentic-development/lib/foundry-common.sh`
- Foundry spec: `brama-core/openspec/specs/pipeline-monitor/spec.md`
- Original proposal: `brama-core/openspec/changes/archive/2026-03-18-fix-pipeline-monitor/proposal.md`
- **Started**: 2026-03-24 12:56:40
- **Branch**: pipeline/restore-full-tui-monitor-for-foundry
- **Pipeline ID**: 20260324_125631

---

## Architect

- **Status**: pending
- **Change ID**: —
- **Apps affected**: —
- **DB changes**: —
- **API changes**: —

## Coder

- **Status**: done
- **Files created**:
  - `agentic-development/lib/pipeline-monitor.sh` — new full TUI monitor (adapted from original 1542-line pipeline-monitor.sh)
- **Files modified**:
  - `agentic-development/foundry.sh` — monitor case now points to `pipeline-monitor.sh` instead of `foundry-monitor.sh`
- **Migrations created**: none
- **Deviations from spec**:
  - Worker tab (tab 3+) removed as specified — Foundry is serial, no worktrees
  - `stat -f%m` macOS fallbacks removed — Linux-only devcontainer
  - Cost tracking stubs kept as no-ops (already stubbed in original)
  - Activity tab reads `events.jsonl` (JSONL format) instead of pipe-delimited `events.log`
  - `action_start_task` (extra worker via worktree) removed — not applicable to Foundry serial model
  - `action_archive` removed — Foundry uses state.json, no archive directory concept
  - `action_stop_task` (move in-progress → todo) removed — Foundry state transitions handled by foundry.sh
  - `l` key now shows `task.md` content (not a separate log file) since Foundry has no per-task log files in the old sense
  - `foundry-monitor.sh` (simple menu) preserved as-is per spec — it remains the fallback for non-interactive use

## Validator

- **Status**: done
- **PHPStan**:
  - No changed validator-target apps in scope (`agentic-development/` changed only) — not run
- **CS-check**:
  - No changed validator-target apps in scope (`agentic-development/` changed only) — not run
- **Files fixed**: none

## Tester

- **Status**: pending
- **Test results**: —
- **New tests written**: —

## Auditor

- **Status**: pending
- **Verdict**: —
- **Recommendations**: —

## Documenter

- **Status**: pending
- **Docs created/updated**: —

## Summarizer

- **Status**: pending
- **Summary file**: —
- **Next task recommendation**: —

---

- **Commit (coder)**: 3811a72
