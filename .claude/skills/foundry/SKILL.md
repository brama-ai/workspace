---
name: foundry
description: >
  Delegate a task to the Foundry pipeline, monitor its execution every 60 seconds,
  auto-fix pipeline errors, and restart until the task completes with summary.md.
  Triggers on: "delegate", "foundry run", "pipeline", "run task", "delegate to foundry".
---

# Foundry Task Delegation & Monitoring

Delegate a task to the Foundry pipeline, watch it until completion, fix errors if they occur,
and ensure the task finishes with a valid `summary.md`.

## When to Use

- User asks to delegate/run a task through Foundry
- User says "run this in pipeline", "delegate to foundry", "foundry run"
- User wants autonomous task execution with oversight

## Success Criteria

A task is considered **successfully completed** when:
- `tasks/<slug>--foundry/summary.md` exists and is non-empty
- `tasks/<slug>--foundry/state.json` has `"status": "completed"`

## Workflow

### Step 1 — Create & Launch Task

Determine the task description from the user's request. Launch Foundry:

```bash
./agentic-development/foundry.sh run "<task description>"
```

If the user specifies a profile, add `--profile <profile>`:
```bash
./agentic-development/foundry.sh run --profile <profile> "<task description>"
```

Capture the task slug from the output. The slug is the directory name under `tasks/` (format: `<slug>--foundry`).

### Step 2 — Monitor Loop

Poll every 60 seconds until the task reaches a terminal state. On each check:

```bash
# 1. Read task state
cat tasks/<slug>--foundry/state.json | jq '{status, current_step, attempt, waiting_agent}'

# 2. Check for summary.md (success indicator)
test -s tasks/<slug>--foundry/summary.md && echo "SUMMARY EXISTS" || echo "NO SUMMARY"

# 3. Check latest events (last 5)
tail -5 tasks/<slug>--foundry/events.jsonl | jq -c '{type, message, step}'
```

**State handling:**

| State | Action |
|-------|--------|
| `pending` | Wait — task is queued |
| `in_progress` | Wait — agents are working. Report current agent to user |
| `waiting_answer` | Alert user — an agent needs input. Show questions from `qa.json` if exists |
| `completed` | Check `summary.md` exists → **done** |
| `failed` | Go to Step 3 (diagnose & fix) |
| `stopped` | Go to Step 3 (diagnose & fix) |
| `suspended` | Report to user, wait for guidance |

**Status updates to user** — report at natural milestones:
- When each new agent starts (read `current_step` from state.json)
- When cost is accumulating significantly (read agents array in state.json)
- When errors or warnings appear in events.jsonl

### Step 3 — Diagnose & Fix Failures

When a task fails:

#### 3.1 Read Diagnostics

```bash
# What failed?
cat tasks/<slug>--foundry/state.json | jq '.agents[] | select(.status == "failed")'

# Last events
tail -20 tasks/<slug>--foundry/events.jsonl | jq -c '{type, message, step}'

# Agent logs (if available)
ls tasks/<slug>--foundry/artifacts/*/
cat tasks/<slug>--foundry/artifacts/<failed-agent>/*.log 2>/dev/null | tail -50
```

#### 3.2 Identify Error Category

| Category | Symptoms | Fix |
|----------|----------|-----|
| **Model rate limit / unavailable** | `model_swap`, `fallback` events, HTTP 429/503 | Usually self-heals via fallback chain. If all models exhausted → wait 5 min, restart |
| **Agent timeout** | `timeout` event, exit code 124 | Check if task is too large. Consider splitting or increasing timeout |
| **Git conflict** | merge/checkout errors in logs | Resolve conflict manually, then restart |
| **Lock contention** | `.claim.lock` or `.batch.lock` stale | Remove stale lock: `rm tasks/<slug>--foundry/.claim.lock` |
| **Preflight failure** | `stopped` with stop_reason | Fix the precondition (service down, missing tool), then restart |
| **Agent logic error** | Agent produced wrong output, tests fail | Read the agent's log, understand what went wrong. If it's a pipeline config issue → fix and restart. If it's a genuine task complexity issue → report to user |
| **Zombie process** | `zombie` in events, stale worker | `./agentic-development/foundry.sh stop` then restart |

#### 3.3 Apply Fix & Restart

After fixing the issue:

```bash
# Resume from failed agent (preserves previous work)
./agentic-development/foundry.sh restart <slug>

# OR fresh start if state is corrupted
./agentic-development/foundry.sh restart <slug> --fresh
```

Then return to **Step 2** (monitor loop).

#### 3.4 Max Retries

- Allow up to **3 restart attempts** for the same task
- If a task fails 3 times, stop and report to the user with full diagnostics
- Include: which agents failed, error category, what was tried, recommendation

### Step 4 — Report Completion

When `summary.md` exists and state is `completed`:

1. Read and present `summary.md` to the user
2. Report key metrics:
   - Total duration
   - Total cost (from state.json agents array)
   - Number of agents that ran
   - Any Q&A interactions that occurred
3. If summary mentions follow-up tasks, present them to the user
4. Report the git branch: `pipeline/<slug>`

## Important Notes

- **Do NOT modify task files** (task.md, state.json) directly — always use foundry.sh commands
- **Do NOT kill agent processes** manually — use `foundry.sh stop`
- **Do NOT push branches** — leave that to the user
- The pipeline runs in the background — you can do other work while monitoring
- If the user asks about progress mid-monitoring, read the latest state and report
- Foundry manages its own git branches — do not interfere with git operations during a run

## Monitoring Command Quick Reference

```bash
# Task status
cat tasks/<slug>--foundry/state.json | jq .status

# Current agent
cat tasks/<slug>--foundry/state.json | jq .current_step

# Cost so far
cat tasks/<slug>--foundry/state.json | jq '[.agents[]?.cost // 0] | add'

# All events
cat tasks/<slug>--foundry/events.jsonl | jq -c '{type, message, step}'

# Handoff progress
cat tasks/<slug>--foundry/handoff.md

# Summary (success check)
cat tasks/<slug>--foundry/summary.md

# Active workers
ps aux | grep foundry-run | grep -v grep

# Pipeline-wide status
./agentic-development/foundry.sh status
```
