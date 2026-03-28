# Ultraworks (Sisyphus)

Ultraworks is the OpenCode-native orchestration mode. The public CLI is [`agentic-development/ultraworks.sh`](/Users/nmdimas/work/brama-workspace/agentic-development/ultraworks.sh).

## Overview

```
User/Command → OpenCode → Sisyphus (OpenCode `build` orchestrator)
                              ↓
              Planner → [Architect] → s-coder → s-auditor
                                                    ↓
                                        ┌───────────┴───────────┐
                                   s-validator              s-tester
                                        └───────────┬───────────┘
                                                    ↓
                                        ┌───────────┴───────────┐
                                   s-documenter            s-summarizer
```

Key difference from Foundry: Ultraworks is built for isolated task runs with tmux sessions and worktrees, and it can parallelize some agent phases inside the OpenCode orchestration.

## Quick Start

### Launch via tmux (recommended)

```bash
# Interactive — opens OpenCode TUI in tmux
./agentic-development/ultraworks.sh launch

# With a task — runs the full pipeline automatically
./agentic-development/ultraworks.sh launch "Fix authentication bug in admin panel"
```

Interactive launch without a task still creates a tmux session named `ultraworks`.

Task launch now creates a dedicated tmux session, branch, and git worktree for that run:
- session: `ultraworks-<slug>-<timestamp>`
- branch: `pipeline/<slug>` (with a collision-safe suffix when needed)
- worktree: `.pipeline-worktrees/ultraworks-<slug>-<timestamp>`

The pipeline then runs inside that isolated worktree, so its runtime state does not overwrite other runs.

### Run headless

```bash
./agentic-development/ultraworks.sh headless "Fix authentication bug in admin panel"
```

Headless mode runs without the interactive menu and still keeps tracked runtime metadata.

### Launch without wrapper

```bash
# Direct OpenCode run (no monitoring, no logging)
opencode run --command auto "Fix authentication bug in admin panel"

# With specific model
opencode run --model openai/gpt-5.4 --command auto "Add streaming support"
```

### Launch from OpenCode TUI

Inside OpenCode, use the `/auto` command:

```
/auto Fix authentication bug in admin panel
```

## Task Storage

Ultraworks stores task-local artifacts in:

```text
tasks/<slug>--ultraworks/
  task.md
  handoff.md
  state.json
  events.jsonl
  summary.md
  meta.json
  artifacts/
```

Wrapper-level logs are written under:

```text
agentic-development/runtime/logs/
```

Execution logs, reports, and run metadata still use `.opencode/pipeline/` and `.opencode/ultraworks/runs/` as transient runtime support layers.

## Multi-Task Execution

Ultraworks isolates each task run by default. Parallel runs launched through `ultraworks.sh launch "..."` or `ultraworks.sh headless "..."` can execute safely because each one gets its own worktree and branch.

If you bypass the wrapper and start raw `opencode run --command auto ...` commands yourself, you are back in shared-checkout mode and must isolate them manually.

### Recommended operator model

Start with `2-3` concurrent Ultraworks tasks and increase only if your host machine, provider quotas, and repository size handle it cleanly. That number is an operational recommendation, not a hard-coded runtime limit.

### Manual multi-session

```bash
# Session 1
tmux new-session -d -s ultra-1 -c "$(pwd)" \
  "opencode run --command auto 'Fix auth bug'; read"

# Session 2
tmux new-session -d -s ultra-2 -c "$(pwd)" \
  "opencode run --command auto 'Add pagination to API'; read"

# Session 3
tmux new-session -d -s ultra-3 -c "$(pwd)" \
  "opencode run --command auto 'Update agent manifest schema'; read"
```

### Monitor all sessions

```bash
# List all ultraworks sessions
tmux list-sessions | grep ultra

# Attach to a specific session
tmux attach -t ultra-1

# Switch between sessions (inside tmux)
# Ctrl+B then S — session picker
# Ctrl+B then ( / ) — prev/next session

# Kill a session
tmux kill-session -t ultra-2
```

### Split-pane multi-task view

Watch multiple pipelines in one terminal:

```bash
# Create main session
tmux new-session -d -s multi-ultra

# Split into 3 panes and run tasks
tmux send-keys -t multi-ultra "opencode run --command auto 'Task 1'" Enter
tmux split-window -h -t multi-ultra
tmux send-keys -t multi-ultra "opencode run --command auto 'Task 2'" Enter
tmux split-window -v -t multi-ultra
tmux send-keys -t multi-ultra "opencode run --command auto 'Task 3'" Enter

# Attach
tmux attach -t multi-ultra
```

> **Note:** The warning about shared `handoff.md` applies to raw/manual `opencode run` sessions launched in the same checkout. The `ultraworks.sh launch "task"` wrapper now creates a separate worktree per task by default.

### Parallel with manual git worktrees

```bash
# Create isolated worktrees
git worktree add .pipeline-worktrees/worker-1 -b pipeline/task-1
git worktree add .pipeline-worktrees/worker-2 -b pipeline/task-2

# Run in separate worktrees
tmux new-session -d -s ultra-1 -c ".pipeline-worktrees/worker-1" \
  "opencode run --command auto 'Task 1'; read"

tmux new-session -d -s ultra-2 -c ".pipeline-worktrees/worker-2" \
  "opencode run --command auto 'Task 2'; read"

# Clean up after done
git worktree remove .pipeline-worktrees/worker-1
git worktree remove .pipeline-worktrees/worker-2
```

## Monitoring

### Interactive Menu

```bash
./agentic-development/ultraworks.sh
```

This is the default entrypoint and acts as the monitor/menu, similar to `foundry`.

### TUI Watch Mode

```bash
./agentic-development/ultraworks.sh watch
```

Live split-panel monitor:

- **Left panel:** task info, handoff state, recent logs
- **Right panel:** agent progress sidebar with status icons

| Icon | Meaning |
|------|---------|
| `✓` | Agent completed |
| `⠋` (spinner) | Agent running |
| `✗` | Agent failed |
| `○` | Agent pending |

| Option | Action |
|--------|--------|
| `1` | Show current state |
| `2` | Launch OpenCode (tmux) |
| `3` | View latest report |
| `4` | View latest summary |
| `5` | View handoff |
| `6` | Tail logs |
| `q` | Quit |

### Status Check (one-shot)

```bash
./agentic-development/ultraworks.sh status
```

Shows: running/idle, current phase, profile, agents, latest report, branch, and active worktree path for the latest active run.

### Attach to Running Session

```bash
# Attach to the latest tracked run
./agentic-development/ultraworks.sh attach

# Or attach to a known session directly
tmux attach -t ultraworks-my-task-20260324_120000

# Detach without stopping: Ctrl+B then D
```

### View Logs

```bash
# Latest log
tail -f .opencode/pipeline/logs/task-*.log | tail -1

# All recent logs
ls -lt .opencode/pipeline/logs/*.log | head -5
```

## Running Without Monitoring

For a completely headless run:

```bash
# Headless mode — logs to file, no TUI
./agentic-development/ultraworks.sh headless "Fix auth bug"

# Direct opencode run (no wrapper, no logging)
opencode run --command auto "Fix auth bug"

# With model override
opencode run --model openai/gpt-5.4 --command auto "Fix auth bug"
```

Headless mode:

- logs output to `.opencode/pipeline/logs/task-YYYYMMDD_HHMMSS-<slug>.log`
- Runs a watchdog that kills stalled pipelines (configurable)
- Auto-creates a PR on success
- Runs internal post-processing on completion (`ultraworks-postmortem-summary.sh` + summary normalization)

### Watchdog Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `ULTRAWORKS_MAX_RUNTIME` | `7200` (2h) | Max total runtime in seconds |
| `ULTRAWORKS_STALL_TIMEOUT` | `900` (15m) | Kill if no log/handoff activity |
| `ULTRAWORKS_WATCHDOG_INTERVAL` | `30` | Check interval in seconds |

## Ultraworks vs Foundry

| Aspect | Foundry | Ultraworks |
|--------|---------|------------|
| Orchestrator | `foundry-run.sh` via `foundry` | Sisyphus (OpenCode `build` orchestrator) |
| Agent prefix | `coder`, `validator` | `s-coder`, `s-validator` |
| Execution | Sequential only | Parallel phases supported |
| Entry point | `foundry` | `ultraworks.sh` |
| Multi-task | Single queue consumer per checkout today | Multiple isolated sessions/worktrees |
| Task source | `tasks/<slug>--foundry>/task.md` or direct `foundry run` input | Prompt text, `ultraworks.sh launch`, or `ultraworks.sh headless` |
| Monitoring | `foundry` monitor | `ultraworks.sh` (`ultraworks-monitor.sh` internally) |
| Git workflow | Creates `pipeline/<slug>` branch | Uses current branch or creates one |
| PR creation | Manual or via webhook | Auto on headless success |

## Commands Reference

| Command | Description |
|---------|-------------|
| `/auto <task>` | Run Sisyphus pipeline (inside OpenCode) |
| `/foundry <task>` | Run Foundry sequential pipeline |
| `/pipeline <task>` | Legacy alias for Foundry sequential pipeline |
| `/implement <change>` | Skip architect, go straight to coder |
| `/validate` | Run validator + tester only |
| `/audit <task>` | Run audit loop: auditor → coder → re-audit |
| `/finish` | Resume pipeline from current handoff state |

## Main Wrapper Commands

```bash
./agentic-development/ultraworks.sh
./agentic-development/ultraworks.sh status
./agentic-development/ultraworks.sh launch "Task"
./agentic-development/ultraworks.sh headless "Task"
./agentic-development/ultraworks.sh watch
./agentic-development/ultraworks.sh attach
./agentic-development/ultraworks.sh logs
./agentic-development/ultraworks.sh env-check
```

## Troubleshooting

### Session exists but process is dead

```bash
# Check
tmux has-session -t ultraworks && echo "exists"
pgrep -f "opencode run.*auto" || echo "no process"

# Fix — kill stale session
tmux kill-session -t ultraworks
```

### Pipeline appears stuck

```bash
# Check watchdog status
./agentic-development/ultraworks.sh status

# Check last handoff activity
stat .opencode/pipeline/handoff.md

# Attach and inspect
tmux attach -t ultraworks
```

### Model not available

```bash
# List available models
opencode models

# Override for a run
opencode run --model google/gemini-3.1-pro --command auto "Task"
```
