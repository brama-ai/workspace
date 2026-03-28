# Pipeline Monitor

This document describes the Foundry monitor TUI and its rework visualization features.

## Overview

The monitor is a terminal UI (TUI) built with Ink/React that displays real-time pipeline state. It reads `state.json` from each task directory and renders task status, agent progress, and rework history.

## Rework Visualization

### Per-Agent Attempt History (Agents Tab)

When a task has been retried, the Agents tab groups agent entries by attempt number:

```
── Attempt #1 (history) ──────────────────────────────
  Agent          Status         Duration    Input   Output     Cost
  u-coder        failed            120s     45K      12K   $0.02
  u-validator    failed             30s      8K       2K   $0.00

── Attempt #2 (current) ──────────────────────────────
  Agent          Status         Duration    Input   Output     Cost
  u-coder        done               95s     42K      11K   $0.02
  u-validator    done               28s      7K       2K   $0.00
```

- Current attempt entries are shown in full color
- Prior attempt entries are dimmed
- Attempt headers show `(current)` or `(history)` labels

### Rework-Requested Indicator

When an agent requests rework (status `rework_requested` or `waiting_answer`), the Agents tab shows a yellow indicator:

```
↻ Rework requested by u-reviewer — pipeline retrying
```

### Task List Badges

In the task list, tasks with multiple attempts show:

```
▸ my-task [u-coder] attempt#2
```

The `attempt#N` badge appears when `state.attempt > 1`.

## Navigation

| Key | Action |
|-----|--------|
| `↑/↓` | Select task / scroll detail |
| `Enter` | View task detail |
| `a` | View agents table for selected task |
| `←/→` | Switch detail tabs (summary/state/task/handoff) |
| `d` | Archive task (requires non-empty summary.md) |
| `Esc` | Back to task list |
| `q` | Quit |

## Archive Guard

Pressing `d` to archive a task will fail with an error message if `summary.md` is empty or missing:

```
Cannot archive task: summary.md is empty or missing
```

The task remains in `tasks/` until the summarizer writes a non-empty summary.
