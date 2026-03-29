# Foundry — Architecture & Coding Conventions

## Philosophy

Foundry is a **process manager for AI agents**, architecturally similar to PHP-FPM:

```
PHP-FPM                          Foundry
─────────────────────────────    ─────────────────────────────
master process                   foundry / foundry CLI
worker pool (php-fpm workers)    batch workers (batch.ts / cmdBatch)
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

### TypeScript first

| Layer | Language | Why |
|-------|----------|-----|
| CLI (`foundry`) | TypeScript | Structured args, types, testable |
| Pipeline runner | TypeScript | Async orchestration, error handling |
| Agent executor | TypeScript | Model fallback chains, timeouts, blacklisting |
| Supervisor | TypeScript | Complex state machine, stall detection |
| State management | TypeScript | JSON read/write, validation |
| Telemetry | TypeScript | Pricing, token counting |
| TUI monitor | TypeScript (React/Ink) | Interactive UI, real-time rendering |
| Batch worker pool | TypeScript | Process forking, flock, worktrees, signal handling |
| Headless launcher | TypeScript | Background queue processing |
| Setup/cleanup | TypeScript | Directory creation, artifact management |
| E2E autofix | Bash (`lib/foundry-e2e.sh`) | E2E test runner + task creation (pending TS port) |

**Rule:** All new logic must be written in TypeScript. Bash is only acceptable for thin glue scripts that spawn processes.

**Migration complete:** All core bash scripts have been migrated to TypeScript. The only remaining bash script is `lib/foundry-e2e.sh` (E2E autofix runner, pending TS port).

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
  │ task.md   │  ← request body (created manually or via CLI)
  │ created   │
  └────┬─────┘
       │ createDefaultState() → status: "todo"
  ┌────▼─────┐
  │   todo    │  ← backlog, waiting for slot (can have many)
  └────┬─────┘
       │ promoteNextTodoToPending() — max 1 in pending at a time
  ┌────▼─────┐
  │ pending   │  ← single slot: next task to run (branch/worktree prepared)
  └────┬─────┘
       │ worker claims (flock) → in_progress
  ┌────▼──────────┐
  │ in_progress    │  ← worker executing agent chain (max = worker count)
  │ state.json     │
  │ events.jsonl   │
  └────┬──────────┘
       │
       ├─────────────┬─────────────┐
       ▼             ▼             ▼
  completed       failed      waiting_answer
       │             │             │
  ┌────▼────┐   ┌────▼────┐   ┌────▼────┐
  │summary.md│   │retry →  │   │ qa.json │
  │= response│   │back to  │   │  HITL   │
  └─────────┘   │  todo    │   └─────────┘
                └─────────┘
```

### How tasks start

| Method | Flow | Who promotes |
|--------|------|-------------|
| `foundry run "task"` | Creates task dir → immediately `in_progress` (skip todo/pending) | runner.ts inline |
| `foundry headless` (batch) | Polls `tasks/` every 15s → `todo→pending→in_progress` | batch.ts `promoteNextTodoToPending()` |
| Manual task.md creation | TUI auto-watcher (5s) detects todo + no headless → starts headless | App.tsx auto-watcher |
| TUI `[s] Start` | If headless running → +1 worker. If not → start headless | actions.ts `startWorkers()` |

### Rules

- **Max 1 task in `pending`** at any time (single-slot gate)
- **`in_progress` count = worker count** (default 1, max 5, configurable via TUI `[+/-]`)
- **`todo` is the backlog** — unlimited tasks can wait here
- On **retry**: failed → todo (goes back to queue)
- On **`foundry run`**: bypasses todo/pending, goes straight to in_progress (direct execution)

### Task dependencies (`blocked_by`)

Tasks can declare dependencies on other tasks via `blocked_by` in state.json:

```json
{
  "status": "todo",
  "priority": 3,
  "blocked_by": ["migrate-utils-to-ts", "add-integration-tests"]
}
```

**Rules:**
- `blocked_by` is an array of task slugs (without `--foundry` suffix)
- A blocked task stays in `todo` until ALL dependencies have `status: "completed"`
- If a dependency task dir doesn't exist → treated as not completed (stays blocked)
- Unblocked tasks are promoted normally by priority
- `foundry run` (direct execution) ignores `blocked_by` — only affects batch/headless queue

**Use case:** Task P3 "delete bash scripts" depends on P2 "migrate utils to TS". Without `blocked_by`, the queue would start P3 before P2 is done.

### Two applications: TUI Monitor vs Headless Worker

Foundry has two separate applications that work together:

| | **TUI Monitor** (`foundry monitor`) | **Headless Worker** (`foundry headless`) |
|---|---|---|
| **Purpose** | Visual dashboard + auto-watcher | Pipeline executor |
| **What it does** | Shows task status, process health, logs; promotes todo→pending; starts headless when needed | Claims pending tasks, runs agent pipeline, writes state.json |
| **Singleton** | Yes — `.monitor.lock` (only 1 TUI at a time) | Yes — `.batch.lock` (only 1 headless pool) |
| **Writes state.json** | Only promote (todo→pending) | Full lifecycle (pending→in_progress→completed/failed) |
| **Runs agents** | No — delegates to headless | Yes — via runner.ts → executor.ts |
| **Entrypoint** | `monitor/src/index.tsx` → `App.tsx` | `monitor/src/cli/batch.ts` → `cmdHeadless()` |
| **Auto-start** | TUI detects todo tasks → starts headless via tmux | Headless polls tasks/ every 15s |

**Interaction flow:**
```
TUI (auto-watcher 15s)              Headless (poll 15s)
│                                    │
├─ detect todo tasks                 │
├─ promoteNextTodoToPending()        │
├─ if no headless → ensureHeadless() │
│                                    ├─ promoteNextTodoToPending()
│                                    ├─ claimNextPendingTask()
│                                    ├─ runPipeline() → agents
│                                    ├─ state: completed/failed
│                                    └─ next iteration...
└─ refresh display
```

Both TUI and headless call `promoteNextTodoToPending()` — this is safe because:
- The function checks for existing pending tasks (single-slot gate)
- State transitions are atomic (write to state.json)
- Lock files prevent double-claiming

### State files

| File | Purpose | Analogy |
|------|---------|---------|
| `task.md` | Task description (input) | Request body |
| `state.json` | Current status, agents, worker, blocked_by | Process status |
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
├── foundry                  # Main CLI entrypoint (bash → npx tsx foundry.ts)
├── CONVENTIONS.md              # This file
├── lib/
│   ├── foundry-e2e.sh          # E2E autofix runner (pending TS port)
│   └── ultraworks-postmortem-summary.sh  # Ultraworks postmortem helper
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

## Testing

### Methodology: Testing Trophy + State Machine Testing

Foundry is a process manager — most logic is **state transitions** and **file I/O**, not pure computation. Classic unit test pyramid doesn't fit. We use the **Testing Trophy** approach:

```
          ╱╲
         ╱E2E╲              Rare — runs real agents, costs $$
        ╱──────╲
       ╱Integration╲        ★ PRIMARY — real tmpdir, real state files
      ╱──────────────╲
     ╱   Unit tests   ╲     Pure functions — math, formatting, categorisation
    ╱──────────────────╲
   ╱   Static Analysis  ╲   TypeScript strict + build check
  ╱────────────────────────╲
```

**Why not the test pyramid?**
- We have few pure functions (unit) — most logic touches filesystem or processes
- E2E (running real agents) costs real money and takes 10-60 minutes
- Integration tests with real `tmpdir` give the highest confidence per test dollar

### Framework: Vitest

```bash
npm test              # run all tests once
npm run test:watch    # watch mode during development
```

Config: `monitor/vitest.config.ts` — globals enabled, test files in `src/__tests__/`.

### Test tiers and what to test where

#### Tier 1: Static Analysis (every change, zero cost)

TypeScript strict mode catches type errors at build time. `npm run build` is the first gate.

**Rule:** Every PR must pass `tsc` with zero errors. This is not optional.

#### Tier 2: Unit Tests — pure logic (fast, no I/O)

Test pure functions that take input and return output with no side effects.

| What to unit test | Example |
|-------------------|---------|
| Error categorisation | `diagnose()` → given these events, returns `timeout` category |
| Stall detection math | `checkStall()` → given idle 700s and threshold 600s, returns stalled |
| Cost/token calculations | `calculateCost()` → given model + tokens, returns $ |
| Duration formatting | `formatDuration(3661)` → `"1h 1m 1s"` |
| Slug generation | `slugify("Hello World!")` → `"hello-world"` |
| Summary status parsing | `getSummaryStatus()` → PASS / FAIL / UNKNOWN |
| Agent timeout lookups | `getTimeout("u-coder")` → `3600` |

**Pattern:**
```typescript
describe("diagnose", () => {
  it("detects timeout from exit code 124", () => {
    const events = [{ type: "AGENT_END", details: { exit_code: 124 } }];
    const result = diagnose(taskDir, stateWithEvents(events));
    expect(result.category).toBe("timeout");
  });
});
```

#### Tier 3: Integration Tests — state machine transitions (core value)

Test that the system correctly transitions between states using **real filesystem** (tmpdir).
This is the **primary test tier** — most test effort goes here.

| What to integration test | Why |
|--------------------------|-----|
| Task lifecycle: pending → in_progress → completed | Core state machine — if this breaks, everything breaks |
| Task lifecycle: in_progress → failed → retry → pending | Retry logic is critical for autonomous operation |
| Supervisor: stall detection → worker restart | Supervisor must react correctly to stalls |
| Supervisor: FAIL summary → fix proposal generation | The proposal must contain actionable information |
| State file I/O: write state → read state → verify fields | JSON serialisation must round-trip correctly |
| Events: emit → parse → verify | Event stream is the audit log |
| Checkpoint: save → resume from correct agent | Resume must not re-run completed agents |
| Handoff: write section → read section → verify | Inter-agent communication must preserve data |

**Pattern — real tmpdir, no mocks:**
```typescript
describe("task lifecycle", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "foundry-test-"));
    process.env.PIPELINE_TASKS_ROOT = root;
  });

  afterEach(() => {
    rmSync(root, { recursive: true });
    delete process.env.PIPELINE_TASKS_ROOT;
  });

  it("pending → in_progress → completed with summary", () => {
    // Arrange: create task in pending state
    const taskDir = createTask(root, "test-task", { status: "pending" });

    // Act: claim task
    setStateStatus(taskDir, "in_progress", "worker-1");
    const state1 = readTaskState(taskDir);
    expect(state1?.status).toBe("in_progress");

    // Act: complete with summary
    setStateStatus(taskDir, "completed");
    writeFileSync(join(taskDir, "summary.md"), "## Status: PASS\n...");

    // Assert
    const state2 = readTaskState(taskDir);
    expect(state2?.status).toBe("completed");
    expect(getSummaryStatus(taskDir)).toBe("PASS");
  });

  it("failed → retry increments attempt and resets to pending", () => {
    const taskDir = createTask(root, "test-task", {
      status: "failed",
      attempt: 1,
    });

    // Act: retry
    incrementAttempt(taskDir);
    setStateStatus(taskDir, "pending");

    // Assert
    const state = readTaskState(taskDir);
    expect(state?.status).toBe("pending");
    expect(state?.attempt).toBe(2);
  });
});
```

**When to mock:**
- `execSync` / `exec` for process spawning (agents, git) — we don't run real agents in tests
- Time (`vi.useFakeTimers()`) for timeout/stall tests
- **Never mock** the filesystem — use real tmpdir

#### Tier 4: E2E Tests — full pipeline (rare, expensive)

Run real agent pipeline end-to-end. These are expensive (agent calls cost $$) and slow (minutes).

**When to run E2E:**
- Before major releases
- After changing agent executor or model fallback logic
- Manually, with `--profile quick-fix` and cheapest models

**NOT in CI** — too expensive and flaky (model availability, rate limits).

### What MUST have tests

Every module with decision logic must have tests. This is a hard rule.

| Module | Required tests | Type |
|--------|---------------|------|
| `state/task-state-v2.ts` | All CRUD operations, status transitions | Integration |
| `state/events.ts` | Emit + parse round-trip | Integration |
| `pipeline/runner.ts` | Agent sequence, failure handling, HITL | Integration (mocked executor) |
| `pipeline/checkpoint.ts` | Save/resume/getResumeAgent | Integration |
| `pipeline/handoff.ts` | Read/write/update sections | Integration |
| `agents/executor.ts` | Timeout, blacklist, fallback chain | Unit + Integration |
| `agents/context-guard.ts` | Model family detection, thresholds | Unit |
| `cli/supervisor.ts` | Stall detection, diagnosis, fix proposals | Unit + Integration |
| `lib/format.ts` | All formatting functions | Unit |
| `state/telemetry.ts` | Cost calculations per provider | Unit |
| `infra/preflight.ts` | Check results for various environments | Integration |

### What does NOT need tests

- **Bash scripts** — tested manually or via E2E
- **TUI components** (`App.tsx`) — visual, tested manually via `foundry monitor`
- **CLI argument parsing** — tested implicitly by integration tests that call commands
- **External tool wrappers** (git.ts) — thin wrappers, tested via integration

### Test file naming and location

```
monitor/src/
├── state/
│   └── task-state-v2.ts
├── cli/
│   └── supervisor.ts
└── __tests__/
    ├── task-state-v2.test.ts    ← matches source module name
    ├── supervisor.test.ts       ← matches source module name
    └── helpers/                 ← shared test utilities (create below)
        └── fixtures.ts          ← createTask(), createState(), etc.
```

**Rule:** test file name = source file name + `.test.ts`. One test file per source module.

### Shared test helpers

Extract common setup to `__tests__/helpers/fixtures.ts`:

```typescript
// __tests__/helpers/fixtures.ts
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export function createTestRoot(): string {
  return mkdtempSync(join(tmpdir(), "foundry-test-"));
}

export function createTask(
  root: string,
  slug: string,
  stateOverrides: Record<string, unknown> = {},
): string {
  const taskDir = join(root, `${slug}--foundry`);
  mkdirSync(taskDir, { recursive: true });
  const state = {
    task_id: `${slug}--foundry`,
    workflow: "foundry",
    status: "pending",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    attempt: 1,
    ...stateOverrides,
  };
  writeFileSync(join(taskDir, "state.json"), JSON.stringify(state, null, 2));
  writeFileSync(join(taskDir, "task.md"), `# ${slug}\n\nTest task.`);
  return taskDir;
}

export function appendEvent(taskDir: string, type: string, message: string): void {
  const event = JSON.stringify({
    timestamp: new Date().toISOString(),
    type,
    message,
    step: null,
  });
  const { appendFileSync } = require("node:fs");
  appendFileSync(join(taskDir, "events.jsonl"), event + "\n");
}

export function writeSummary(taskDir: string, status: "PASS" | "FAIL", content = ""): void {
  writeFileSync(
    join(taskDir, "summary.md"),
    `# Summary\n\n## Загальний статус\n- **Статус:** ${status}\n\n${content}`,
  );
}
```

### Running tests

```bash
# All tests
cd agentic-development/monitor && npm test

# Specific module
npx vitest run src/__tests__/supervisor.test.ts

# Watch mode during development
npm run test:watch

# With coverage
npx vitest run --coverage
```

### CI rule

Every PR that modifies `monitor/src/` must:
1. Pass `npm run build` (TypeScript compiles)
2. Pass `npm test` (all tests green)
3. Include tests for new logic (supervisor, new commands, new state transitions)

No exceptions. A feature without tests is not done.

---

## Writing New Foundry Code

### Checklist for new modules

1. **TypeScript** — not bash (unless pure process management)
2. **Add `debug()` function** — with `[module-name]` prefix
3. **Use `rlog()`** for key state transitions — model calls, status changes
4. **Use `emitEvent()`** for pipeline lifecycle — visible in events.jsonl
5. **Error handling** — catch and log, never crash the pipeline silently
6. **Types** — use existing interfaces from `task-state-v2.ts`, `runner.ts`
7. **Tests** — mandatory for any decision logic. See Testing section above

### Adding a new CLI command

1. Create handler function in `cli/foundry.ts` or separate module in `cli/`
2. Wire into the `switch(cmd)` in `main()`
3. Add to `showHelp()` output
4. Add to `foundry` TS routing: `run|status|...|new-command)`
5. Add to foundry help text
6. **Add integration test** in `__tests__/<command>.test.ts`

### Adding a new agent

1. Create agent prompt in `.opencode/agents/u-<name>.md`
2. Add default timeout in `agents/executor.ts` TIMEOUTS map
3. Add default fallback chain in `pipeline/runner.ts` DEFAULT_FALLBACKS
4. Add stall threshold in `cli/supervisor.ts` AGENT_STALL_THRESHOLD
5. Add to PROFILES in `cli/foundry.ts` if part of a profile
6. **Add test** for new timeout/threshold in existing test files
7. Update this document
