# Foundry — Architecture & Coding Conventions

## Philosophy

Foundry is a **process manager for AI agents**, architecturally similar to PHP-FPM:

```
PHP-FPM                          Foundry
─────────────────────────────    ─────────────────────────────
master process                   foundry.sh / foundry-ts CLI
worker pool (php-fpm workers)    batch workers (foundry-batch.sh)
request queue                    tasks/ directory (task pool)
php script execution             agent execution (u-planner, u-coder, …)
HTTP response                    summary.md (response)
fastcgi_finish_request()         events.jsonl + state.json (lifecycle)
error_log                        runtime/logs/ + events.jsonl
php.ini                          .env (PIPELINE_*, FOUNDRY_*)
```

### Core Analogy

| Concept | PHP-FPM | Foundry |
|---------|---------|---------|
| **Input** | HTTP request | `tasks/<slug>--foundry/task.md` |
| **Worker** | php-fpm child | batch worker + agent chain |
| **Output** | HTTP response body | `summary.md` |
| **No response** | 502 Bad Gateway (crash) | Missing summary = crash |
| **Success** | 200 OK | summary.md with status PASS |
| **Failure** | 500 Internal Server Error | summary.md with status FAIL |
| **Pool** | pm.max_children | `--workers N` |
| **Lifecycle** | request → process → response | pending → in_progress → completed |
| **Health check** | ping/pong, slow log | stall detection, events.jsonl |
| **Restart policy** | pm.max_requests | max retries + fallback models |

### Key Principles

1. **`tasks/` is the queue** — tasks enter as `pending`, workers claim and execute them
2. **`summary.md` is the response** — if it exists, the task answered. If it doesn't, the task crashed
3. **Responses can be PASS or FAIL** — FAIL is not a crash, it's a valid response with diagnostics
4. **The supervisor watches the pool** — detects stalls, restarts dead workers, retries crashes
5. **Agents are the request handlers** — each agent is a processing step (like middleware + handler)

---

## Language Policy

### TypeScript first, bash only for glue

| Layer | Language | Why |
|-------|----------|-----|
| CLI (`foundry-ts`) | TypeScript | Structured args, types, testable |
| Pipeline runner | TypeScript | Async orchestration, error handling |
| Agent executor | TypeScript | Model fallback chains, timeouts, blacklisting |
| Supervisor | TypeScript | Complex state machine, stall detection |
| State management | TypeScript | JSON read/write, validation |
| Telemetry | TypeScript | Pricing, token counting |
| TUI monitor | TypeScript (React/Ink) | Interactive UI, real-time rendering |
| Batch worker pool | Bash | Process forking, flock, worktrees, signal handling |
| Headless launcher | Bash | `nohup`, background process management |
| Setup/cleanup | Bash | Directory creation, file permissions |

**Rule:** If it has logic — write it in TypeScript. If it only spawns processes or manages files — bash is acceptable.

**Migration direction:** Bash → TypeScript. Never add new logic to bash scripts. When touching an existing bash function that has complex logic, consider rewriting it in TS.

---

## Debug & Logging

### Three-tier logging

```
Tier 1: rlog()        → JSON file on disk     (always on for key events)
Tier 2: debug()       → stderr console         (only if FOUNDRY_DEBUG=true)
Tier 3: emitEvent()   → events.jsonl per task  (pipeline state stream)
```

### FOUNDRY_DEBUG

Controlled via `.env` or environment:

```bash
FOUNDRY_DEBUG=true    # enable verbose debug output
```

Every logical node MUST have debug output when `FOUNDRY_DEBUG=true`.

### Debug function pattern (mandatory in every module)

```typescript
import { env } from "node:process";

const DEBUG = env.FOUNDRY_DEBUG === "true";

function debug(...args: unknown[]): void {
  if (!DEBUG) return;
  const ts = new Date().toISOString().split("T")[1].slice(0, 12);
  console.error(`[${ts}] [module-name]`, ...args);
}
```

Rules:
- **Output to `stderr`** (`console.error`), never stdout — stdout is for user-facing output
- **Timestamp format:** `HH:MM:SS.mmm` (extracted from ISO string)
- **Prefix:** `[module-name]` — identifies the source module
- **Never throw** — debug logging must never break the pipeline
- **Wrap in try/catch** if the debug payload could itself throw

### What to log at each tier

| Tier | What | Example |
|------|------|---------|
| `rlog()` | Model calls, blacklisting, key state transitions | `rlog("model_call_started", { agent, model, timeout })` |
| `debug()` | Decision points, branch logic, computed values | `debug("stall check", { idleSec, threshold, step })` |
| `emitEvent()` | Pipeline lifecycle events | `emitEvent("AGENT_START", { agent: "u-coder" })` |

### Runtime logger (rlog)

```typescript
import { rlog } from "../lib/runtime-logger.js";

rlog("event_name", { key: "value" });            // INFO level
rlog("error_name", { key: "value" }, "ERROR");   // ERROR level
```

- Writes to `agentic-development/runtime/logs/foundry-runtime-YYYY-MM-DD.log`
- KEY_EVENTS (model_blacklisted, model_call_started, model_call_error) always logged regardless of FOUNDRY_DEBUG
- Structured JSON, one line per entry
- Never throws — errors silently ignored

---

## Environment Variables

Prefix convention: `FOUNDRY_` for foundry internals, `PIPELINE_` for pipeline config.

### Core variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FOUNDRY_DEBUG` | `false` | Enable debug logging across all modules |
| `FOUNDRY_ROOT` | `process.cwd()` | Root directory override |
| `PIPELINE_TASKS_ROOT` | `$REPO_ROOT/tasks` | Task pool directory |
| `PIPELINE_MAX_RETRIES` | `2` | Max agent-level retries |
| `PIPELINE_RETRY_DELAY` | `30` | Delay between retries (seconds) |
| `FOUNDRY_WORKERS` | `2` | Default headless worker count |

### Per-agent overrides

Agent name in env: strip `u-` prefix, uppercase, hyphens to underscores.

| Pattern | Example | Description |
|---------|---------|-------------|
| `PIPELINE_MODEL_<AGENT>` | `PIPELINE_MODEL_CODER=anthropic/claude-sonnet-4-6` | Override primary model |
| `PIPELINE_TIMEOUT_<AGENT>` | `PIPELINE_TIMEOUT_CODER=7200` | Override timeout (seconds) |
| `PIPELINE_FALLBACK_<AGENT>` | `PIPELINE_FALLBACK_CODER=model1,model2` | Custom fallback chain |

---

## Task Lifecycle

```
                    ┌──────────┐
                    │ task.md   │  ← request body
                    │ created   │
                    └────┬─────┘
                         │
                    ┌────▼─────┐
                    │ pending   │  ← in queue, waiting for worker
                    └────┬─────┘
                         │ worker claims (flock)
                    ┌────▼──────────┐
                    │ in_progress    │  ← worker executing agent chain
                    │ state.json     │
                    │ events.jsonl   │
                    └────┬──────────┘
                         │
           ┌─────────────┼─────────────┐
           ▼             ▼             ▼
      completed       failed      waiting_answer
           │             │             │
      ┌────▼────┐   ┌────▼────┐   ┌────▼────┐
      │summary.md│   │retry?   │   │ qa.json │
      │= response│   │or report│   │  HITL   │
      └─────────┘   └─────────┘   └─────────┘
```

### State files

| File | Purpose | Analogy |
|------|---------|---------|
| `task.md` | Task description (input) | Request body |
| `state.json` | Current status, agents, worker | Process status |
| `events.jsonl` | Timestamped event stream | Access log |
| `summary.md` | Final output (response) | Response body |
| `handoff.md` | Inter-agent context | Shared memory |
| `qa.json` | Human-in-the-loop Q&A | Interactive request |
| `artifacts/` | Agent logs, telemetry | Error logs |
| `fix-proposal.md` | Supervisor's fix suggestions | Error diagnosis |
| `.claim.lock` | Worker claim lock | PID file |

---

## Supervisor (Process Health Monitor)

The supervisor is the equivalent of PHP-FPM's master process — it watches the pool.

### Stall detection thresholds

Based on agent timeouts — if no new event appears within the threshold, the agent is considered stalled:

| Agent | Stall threshold | Agent timeout |
|-------|----------------|---------------|
| `u-summarizer` | 5 min | 15 min |
| `u-planner`, `u-validator`, `u-tester` | 10 min | 15–30 min |
| `u-architect` | 15 min | 45 min |
| `u-coder` | 20 min | 60 min |
| `pending` (no worker) | 6 min | — |

### Error categories

| Category | Detection | Auto-fix |
|----------|-----------|----------|
| `timeout` | exit code 124, `hard_timeout` event | Retry with fallback models |
| `rate_limit` | HTTP 429/503, `model_swap` event | Wait 60s, retry |
| `git_conflict` | merge/conflict in events | Manual (cannot auto-fix) |
| `zombie` | stale lock, dead worker PID | Clean lock, restart workers |
| `preflight` | `stop_reason` event | Run setup, retry |
| `summary_fail` | summary.md exists with FAIL | Analyze + retry |
| `agent_error` | Agent failed, no specific pattern | Retry |

---

## Code Structure

```
agentic-development/
├── foundry.sh                  # Entry dispatcher (bash → TS routing)
├── foundry-ts                  # TS CLI binary (compiled)
├── CONVENTIONS.md              # This file
├── lib/
│   ├── foundry-common.sh       # Shared bash helpers (legacy)
│   ├── foundry-batch.sh        # Worker pool manager (bash — process management)
│   ├── foundry-retry.sh        # Retry helper (bash)
│   └── ...                     # Other bash scripts (legacy)
├── monitor/
│   └── src/
│       ├── cli/
│       │   ├── foundry.ts      # CLI commands: run, status, list, supervisor
│       │   └── supervisor.ts   # Autonomous runner (TS)
│       ├── pipeline/
│       │   ├── runner.ts       # Pipeline orchestrator
│       │   ├── handoff.ts      # Agent context sharing
│       │   └── checkpoint.ts   # Resume/checkpoint logic
│       ├── agents/
│       │   ├── executor.ts     # Agent execution + model fallbacks
│       │   └── context-guard.ts # Session context monitoring
│       ├── state/
│       │   ├── task-state-v2.ts # Task state CRUD
│       │   ├── events.ts       # Event emission
│       │   └── telemetry.ts    # Cost/token tracking
│       ├── infra/
│       │   ├── git.ts          # Git operations
│       │   └── preflight.ts    # Environment validation
│       ├── lib/
│       │   ├── runtime-logger.ts # Structured disk logging (rlog)
│       │   └── format.ts       # Display formatting
│       └── components/
│           └── App.tsx          # TUI monitor (React/Ink)
└── runtime/
    └── logs/                    # Runtime log files
```

---

## Writing New Foundry Code

### Checklist for new modules

1. **TypeScript** — not bash (unless pure process management)
2. **Add `debug()` function** — with `[module-name]` prefix
3. **Use `rlog()`** for key state transitions — model calls, status changes
4. **Use `emitEvent()`** for pipeline lifecycle — visible in events.jsonl
5. **Error handling** — catch and log, never crash the pipeline silently
6. **Types** — use existing interfaces from `task-state-v2.ts`, `runner.ts`
7. **Test** — add to `__tests__/` if it has logic worth testing

### Adding a new CLI command

1. Create handler function in `cli/foundry.ts` or separate module in `cli/`
2. Wire into the `switch(cmd)` in `main()`
3. Add to `showHelp()` output
4. Add to `foundry.sh` TS routing: `run|status|...|new-command)`
5. Add to foundry.sh help text

### Adding a new agent

1. Create agent prompt in `.opencode/agents/u-<name>.md`
2. Add default timeout in `agents/executor.ts` TIMEOUTS map
3. Add default fallback chain in `pipeline/runner.ts` DEFAULT_FALLBACKS
4. Add stall threshold in `cli/supervisor.ts` AGENT_STALL_THRESHOLD
5. Add to PROFILES in `cli/foundry.ts` if part of a profile
6. Update this document
