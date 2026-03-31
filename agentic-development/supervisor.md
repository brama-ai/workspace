# Foundry Supervisor — Behavioral Contract

This document defines the behavioral contract for the Foundry sidebar chat agent when performing supervision duties. The chat agent follows these rules during both on-demand supervision requests and scheduled periodic watch jobs.

## Purpose

The sidebar supervisor replaces the standalone `foundry supervisor` CLI as the primary operator-facing supervision surface. Instead of running a separate command, the operator converses with the Foundry chat agent inside the monitor sidebar.

## Supervision Scope

During each supervision pass, the chat agent inspects the following signals in priority order:

### Priority 1 — Critical (always report)

| Signal | Source | What to check |
|--------|--------|---------------|
| **Stalled tasks** | Task state + events.jsonl | Tasks in `in_progress` with no new event beyond the agent stall threshold |
| **Zombie processes** | Process health | Workers with stale locks or dead PIDs |
| **Failed tasks** | Task state | Tasks in `failed` status, especially with no retry remaining |
| **Waiting-answer tasks** | Task state + qa.json | Tasks blocked on HITL input with unanswered questions |

### Priority 2 — Warning (report when present)

| Signal | Source | What to check |
|--------|--------|---------------|
| **Blacklisted models** | Model inventory + blacklist | Models that have been blacklisted since the last check |
| **Pending bottleneck** | Task state | Tasks stuck in `pending` beyond 6 minutes with no worker claiming them |
| **FAIL summaries** | summary.md | Completed tasks where the summary status is FAIL |
| **High retry count** | Task state | Tasks on attempt 3+ that keep failing |

### Priority 3 — Informational (report on request or when idle)

| Signal | Source | What to check |
|--------|--------|---------------|
| **Queue depth** | Task counts | Number of `todo` and `pending` tasks waiting |
| **Cost accumulation** | Agent telemetry | Total cost across running and completed tasks |
| **Model usage distribution** | Model inventory | Which models are being used and their health status |
| **Completed task summaries** | summary.md | Recent successful completions and their outcomes |

## Default Behavior

### Supervision interval

When the operator asks the chat agent to watch tasks without specifying an interval, the default supervision interval is **5 minutes** (300 seconds).

### Supervision response format

Each supervision check produces a concise status update that includes:

1. **Status line** — one-sentence summary of overall health (healthy / warning / critical)
2. **Critical findings** — any Priority 1 signals detected
3. **Warnings** — any Priority 2 signals detected
4. **Recommendation** — suggested operator action if any issue is found

### Quiet mode

If no issues are found during a scheduled supervision check, the agent posts a brief "all clear" message rather than a full report. This keeps the chat history clean during healthy operation.

## Context Assembly

The supervisor uses the same structured monitor context assembler as regular chat messages. Each scheduled check triggers a fresh context assembly — the supervisor never reasons from stale data.

The context snapshot includes:
- Task counts by status (todo, pending, in_progress, waiting_answer, completed, failed)
- Per-task detail for running and failed tasks (current step, worker, elapsed time, failed agent)
- Process health (workers, zombies, lock status)
- Model inventory with blacklist status
- QA state for waiting-answer tasks

## Watch Job Lifecycle

1. **Creation** — operator asks the chat to watch (e.g., "keep an eye on tasks")
2. **Scheduling** — Foundry stores the watch job in the sidebar session state with the interval
3. **Execution** — at each interval, Foundry assembles fresh context and sends it to the chat agent
4. **Reporting** — the agent posts findings into the sidebar chat history
5. **Persistence** — watch jobs survive TUI restarts via session persistence
6. **Cancellation** — operator asks the chat to stop watching, or runs `/new` to start a fresh session

## Stall Detection Thresholds

The supervisor uses the same per-agent stall thresholds as the legacy supervisor:

| Agent | Stall threshold |
|-------|----------------|
| `u-summarizer` | 5 min |
| `u-planner`, `u-validator`, `u-tester` | 10 min |
| `u-architect` | 15 min |
| `u-coder` | 20 min |
| `pending` (no worker) | 6 min |

## Relationship to Legacy Supervisor

The `foundry supervisor` CLI command is deprecated in favor of the sidebar chat. During the deprecation window:

- `foundry supervisor` continues to work but emits a deprecation notice
- The notice directs operators to use `foundry monitor` sidebar chat instead
- The underlying supervision logic (stall detection, diagnosis, retry) remains available to both paths
- Removal of the legacy command will happen in a future change after the sidebar workflow is proven
