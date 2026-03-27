# Agentic Development Runtime

Pipeline orchestration for AI agents — Foundry (queue-driven) and Ultraworks (parallel).

## Architecture

```
agentic-development/
├── foundry.sh            ← Main CLI (hybrid TS + Bash)
├── foundry-ts            ← TypeScript CLI wrapper
├── ultraworks.sh         ← Ultraworks CLI
│
├── monitor/              ← TypeScript modules + React/Ink TUI
│   └── src/
│       ├── cli/          ← CLI entrypoints
│       ├── state/        ← State management, telemetry, events
│       ├── pipeline/     ← Runner, checkpoint, handoff
│       ├── agents/       ← Agent execution, fallback
│       ├── infra/        ← Git, preflight, env checks
│       ├── lib/          ← TUI helpers (tasks, actions, format)
│       ├── components/   ← React/Ink TUI (App.tsx)
│       └── __tests__/    ← 188 tests (13 files)
│
├── lib/                  ← Bash runtime scripts (legacy, shrinking)
│   ├── foundry-common.sh ← Shared functions (0 Python)
│   ├── foundry-run.sh    ← Sequential pipeline executor
│   ├── foundry-batch.sh  ← Parallel worker manager
│   └── ...               ← env-check, preflight, e2e, stats
│
├── runtime/logs/         ← Wrapper-level logs
├── telegram-qa/          ← Telegram HITL bot
├── doctor/               ← Root cause analysis reports
└── tests/                ← Bash integration tests
```

## Entry Points

| Command | Technology | Purpose |
|---------|-----------|---------|
| `./foundry.sh run "task"` | TypeScript | Run pipeline task |
| `./foundry.sh status` | TypeScript | Show task status |
| `./foundry.sh list` | TypeScript | List all tasks |
| `./foundry.sh counts` | TypeScript | Count tasks by status |
| `./foundry.sh preflight` | TypeScript | Run preflight checks |
| `./foundry.sh env-check` | TypeScript | Run environment checks |
| `./foundry.sh resume <slug>` | TypeScript | Resume paused task |
| `./foundry.sh checkpoint <slug>` | TypeScript | Show checkpoint summary |
| `./foundry.sh monitor` | React/Ink | Interactive TUI |
| `./foundry.sh headless` | Bash | Background queue processing |
| `./foundry.sh batch` | Bash | Parallel worker manager |
| `./foundry.sh stop` | Bash | Stop background workers |

## TypeScript Modules (2945 lines)

### `cli/` — CLI Entrypoints

| File | Lines | Description |
|------|-------|-------------|
| `foundry.ts` | 409 | Unified CLI: run, status, list, preflight, env-check, resume |
| `run.ts` | 184 | Pipeline run command with profile selection |

### `state/` — State Management

| File | Lines | Description |
|------|-------|-------------|
| `task-state-v2.ts` | 381 | Task CRUD, QA operations, slugify, find/list tasks |
| `telemetry.ts` | 290 | Token tracking, cost calculation, checkpoint records |
| `events.ts` | 109 | Pipeline event logging (JSONL) |

### `pipeline/` — Pipeline Logic

| File | Lines | Description |
|------|-------|-------------|
| `checkpoint.ts` | 248 | Checkpoint persistence, resume detection, summary |
| `handoff.ts` | 218 | Agent-to-agent communication via handoff.md |
| `runner.ts` | 201 | Main pipeline loop, agent orchestration |

### `agents/` — Agent Execution

| File | Lines | Description |
|------|-------|-------------|
| `executor.ts` | 286 | Agent execution with timeout, fallback, blacklist |

### `infra/` — Infrastructure

| File | Lines | Description |
|------|-------|-------------|
| `preflight.ts` | 331 | Preflight checks, env validation, workspace clean |
| `git.ts` | 288 | Git operations: branch, commit, worktree, merge |

### `lib/` — TUI Helpers

| File | Lines | Description |
|------|-------|-------------|
| `task-state.ts` | 506 | Original TUI state management (used by App.tsx) |
| `normalize-summary.ts` | 459 | Summary normalization CLI |
| `tasks.ts` | 307 | Task filesystem helpers |
| `actions.ts` | 252 | TUI actions (start, stop, retry) |
| `format.ts` | 27 | Formatting helpers |

## Bash Scripts (7568 lines, 4 Python calls remaining)

| File | Lines | Python | Description |
|------|-------|--------|-------------|
| `foundry-run.sh` | 3128 | 0 | Sequential pipeline executor |
| `foundry-common.sh` | 1536 | 0 | Shared functions: state, worktree, QA |
| `env-check.sh` | 540 | 1 | Environment validation |
| `foundry-preflight.sh` | 525 | 0 | Pre-flight safety checks |
| `cost-tracker.sh` | 497 | 1 | Token cost tracking |
| `foundry-batch.sh` | 297 | 0 | Parallel worker manager |
| `foundry-e2e.sh` | 284 | 2 | E2E → task creation |
| `ultraworks-postmortem-summary.sh` | 138 | 0 | Summary generation |
| `foundry.sh` | 134 | 0 | Hybrid CLI (TS + Bash) |
| `foundry-telegram.sh` | 107 | 0 | Telegram HITL notifications |
| `foundry-retry.sh` | 78 | 0 | Retry failed tasks |
| `foundry-stats.sh` | 70 | 0 | Task statistics |
| `foundry-cleanup.sh` | 56 | 0 | Cleanup old tasks |
| `foundry-setup.sh` | 21 | 0 | Directory initialization |

## Tests (188 tests, 13 files)

| Test File | Tests | Covers |
|-----------|-------|--------|
| `task-state.test.ts` | 29 | Original TUI state management |
| `task-state-v2.test.ts` | 25 | State CRUD, QA, slugify, format |
| `tasks.test.ts` | 16+ | Task filesystem helpers |
| `App.test.tsx` | 16 | TUI component rendering |
| `telemetry.test.ts` | 14 | Cost calculation, checkpoint, summary |
| `checkpoint.test.ts` | 14 | Persistence, resume, render |
| `format.test.ts` | 14 | Formatting helpers |
| `executor.test.ts` | 12 | Blacklist, timeout, fallback |
| `handoff.test.ts` | 11 | Read/write, sections, files |
| `actions.test.ts` | 10 | TUI actions |
| `preflight.test.ts` | 10 | Preflight, env-check, workspace |
| `events.test.ts` | 8 | Event emit, parse |
| `runner.test.ts` | 6 | Pipeline flow, HITL, cost |

```bash
# Run all tests
cd agentic-development/monitor && npm test

# Run specific test file
npm test -- --run src/__tests__/checkpoint.test.ts

# Watch mode
npm test -- --watch
```

## Task Directory Structure

```
tasks/<slug>--foundry/
├── task.md              ← Task prompt (input)
├── state.json           ← Machine state (status, agents, telemetry)
├── handoff.md           ← Agent-to-agent communication
├── events.jsonl         ← Event history
├── summary.md           ← Final summary (output)
├── meta.json            ← Metadata (branch, created_at)
├── qa.json              ← HITL questions/answers
├── pipeline-plan.json   ← Planner output (profile, agents)
├── .claim.lock          ← Atomic task claiming (flock)
└── artifacts/
    ├── checkpoint.json  ← Agent completion checkpoints
    └── telemetry/       ← Per-agent telemetry records
```

---

## Development Guidelines

### SOLID Principles

**Single Responsibility:** Each file has one job. Maximum ~200 lines per module.

```
✅ state/events.ts       — event logging only
✅ agents/executor.ts     — agent execution only
✅ pipeline/checkpoint.ts — checkpoint persistence only

❌ foundry-run.sh (3128 lines) — does everything (legacy, migrating)
```

**Open/Closed:** Add new agent types by adding config, not by modifying executor.

**Interface Segregation:** Each module exports only what consumers need.

**Dependency Inversion:** Modules depend on interfaces (TaskState, AgentConfig), not concrete implementations.

### File Size Rules

| Type | Max Lines | Action if exceeded |
|------|-----------|-------------------|
| TypeScript module | 200 | Split into sub-modules |
| Test file | 400 | Split by describe block |
| Bash script | 500 | Migrate to TypeScript |
| Component (TSX) | 300 | Extract sub-components |

### Adding New Features

1. **Create module** in the appropriate directory:
   - State logic → `state/`
   - Pipeline logic → `pipeline/`
   - Infrastructure → `infra/`
   - Agent logic → `agents/`
   - CLI commands → `cli/`

2. **Write tests first** (or alongside):
   ```bash
   # Create test file
   monitor/src/__tests__/my-feature.test.ts
   
   # Run tests in watch mode
   cd monitor && npm test -- --watch src/__tests__/my-feature.test.ts
   ```

3. **Type check:**
   ```bash
   cd monitor && npx tsc --noEmit
   ```

4. **Update this README** — add file to the module table above.

5. **Update audit.md** if it changes Python call counts.

### Testing Requirements

**Every new TypeScript module MUST have tests.**

| Test Type | When | Example |
|-----------|------|---------|
| **Unit** | Pure functions, calculations | `calculateCost()`, `slugify()`, `formatDuration()` |
| **Integration** | File I/O, state management | `readTaskState()`, `writeCheckpoint()` |
| **Functional** | CLI commands, workflows | `runPipeline()`, `executeAgent()` |

**Test patterns:**

```typescript
// Unit test
it("calculates cost for claude-sonnet", () => {
  const cost = calculateCost("claude-sonnet-4-20250514", 1_000_000, 500_000);
  expect(cost).toBeCloseTo(10.5, 1);
});

// Integration test (temp dir)
let testDir: string;
beforeEach(() => {
  testDir = join(tmpdir(), `test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
});
afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

it("writes and reads state", () => {
  writeTaskState(testDir, { task_id: "test", workflow: "foundry", status: "pending" });
  const state = readTaskState(testDir);
  expect(state!.status).toBe("pending");
});

// Functional test (mocked dependencies)
vi.mock("../agents/executor.js", () => ({
  executeAgent: vi.fn(async () => ({ success: true, exitCode: 0, ... })),
}));
```

**Test naming convention:**
- `<module-name>.test.ts` — matches the source file
- Located in `src/__tests__/`
- Use `describe()` blocks grouped by function

### Debug Mode

Set `FOUNDRY_DEBUG=true` for detailed logging across all modules.

```bash
# Enable debug for all commands
FOUNDRY_DEBUG=true ./foundry.sh run "task description"

# Or set in .env.local (auto-detected)
echo "FOUNDRY_DEBUG=true" >> .env.local
```

**What debug mode provides:**

| Component | Log Location | What it logs |
|-----------|-------------|-------------|
| TypeScript modules | stderr | `[HH:MM:SS.mmm] [module] message` |
| Bash functions | `runtime/logs/foundry-debug.log` | `[timestamp] [category] message` |
| Pipeline events | `tasks/<slug>/events.jsonl` | Every agent start/end, HITL, error |

**Example debug output:**
```
[12:34:56.789] [runner] pipeline start {branch: "pipeline/my-task", agents: 5}
[12:34:57.012] [executor] starting agent u-coder timeout 3600 models 2
[12:35:02.345] [state] Wrote state: /tasks/my-task--foundry/state.json
[12:40:15.678] [executor] agent completed u-coder duration 318
```

**Diagnosing issues:**

```bash
# Process hangs — find what's running
./foundry.sh status                           # TS: task counts
ps aux | grep -E "foundry|opencode"           # Processes

# Task failed — check events
cat tasks/<slug>--foundry/events.jsonl | jq .

# Agent stalled — check state
jq '.agents' tasks/<slug>--foundry/state.json

# Zombie processes — use Doctor
opencode run --agent u-doctor "Diagnose current Foundry state"

# Full diagnostics
FOUNDRY_DEBUG=true ./foundry.sh run "task" 2>debug.log
```

### Code Conventions

**TypeScript:**
- ES modules (`import/export`), no CommonJS
- Strict mode (`"strict": true` in tsconfig)
- No `any` types — use proper interfaces
- Functions over classes (functional style)
- Each module has a CLI entry point (`if (isMain)`)

**Bash:**
- `set -euo pipefail` in every script
- `jq` for JSON manipulation (no Python)
- `flock` for atomic file locking (no Python `fcntl`)
- `_track_usage()` for usage tracking
- `debug_log()` for debug output

**Naming:**
- TypeScript files: `kebab-case.ts`
- Bash files: `foundry-<feature>.sh`
- Test files: `<module>.test.ts`
- Interfaces: `PascalCase` (TaskState, AgentConfig)
- Functions: `camelCase` in TS, `snake_case` in Bash

### Migration Status (Python → jq/TS)

| Metric | Before | After | Δ |
|--------|--------|-------|---|
| Python calls | 46 | **4** | **-91%** |
| TypeScript lines | 777 | **2945** | +279% |
| Tests | 114 | **188** | +65% |
| tsc errors | 22 | **0** | -100% |

Remaining Python (4 calls):
- `cost-tracker.sh:1` — `render_ultraworks_summary_block` (200+ lines, deep `opencode session` integration)
- `env-check.sh:1` — Python version detection
- `foundry-e2e.sh:2` — E2E report parsing + task generation

## Foundry Commands

```bash
# TypeScript commands (fast, no Python)
./foundry.sh run "task description"        # Run pipeline
./foundry.sh run --profile quick-fix "fix" # Use specific profile
./foundry.sh run --task-file task.md       # Read task from file
./foundry.sh run --only u-validator        # Run single agent
./foundry.sh status [slug]                 # Show task status
./foundry.sh list                          # List all tasks
./foundry.sh counts                        # Count by status
./foundry.sh preflight                     # Run preflight checks
./foundry.sh env-check [profile]           # Check environment
./foundry.sh resume <slug>                 # Resume paused task
./foundry.sh checkpoint <slug>             # Show checkpoint summary

# Bash commands (legacy)
./foundry.sh monitor                       # Interactive TUI
./foundry.sh headless                      # Background queue
./foundry.sh stop                          # Stop workers
./foundry.sh batch [--workers N]           # Parallel workers
./foundry.sh retry                         # Retry failed tasks
./foundry.sh stats                         # Pipeline statistics
./foundry.sh cleanup                       # Clean old artifacts
./foundry.sh setup                         # Initialize directories
./foundry.sh e2e-autofix [--smoke]         # E2E → fix tasks
```

## Ultraworks

Ultraworks is the OpenCode-native orchestrator — parallel runs in isolated git worktrees.

```bash
./ultraworks.sh                            # Open TUI
./ultraworks.sh launch "task"              # Interactive in tmux
./ultraworks.sh headless "task"            # Background run
./ultraworks.sh status                     # Show status
./ultraworks.sh watch                      # Live watch
./ultraworks.sh attach                     # Attach to session
./ultraworks.sh logs                       # Show logs
```

## Logs

| Log | Location | Content |
|-----|----------|---------|
| Foundry wrapper | `runtime/logs/foundry.log` | CLI-level events |
| Foundry headless | `runtime/logs/foundry-headless.log` | Batch stdout/stderr |
| Ultraworks | `runtime/logs/ultraworks.log` | CLI-level events |
| Debug | `runtime/logs/foundry-debug.log` | Detailed debug (`FOUNDRY_DEBUG=true`) |
| Pipeline | `.opencode/pipeline/logs/` | Per-run execution logs |
| Reports | `.opencode/pipeline/reports/` | E2E reports, env reports |
| Events | `tasks/<slug>/events.jsonl` | Per-task event stream |

## Doctor (Diagnostics)

```bash
/doctor                # Diagnose and create root cause report
/doctor analyze        # Pattern analysis from previous reports
/doctor fix            # Apply state fixes (safe only)
```

Reports are saved in `doctor/root-cause-*.md`. When 3+ reports show the same issue, Doctor recommends a code fix.

## Setup

```bash
./foundry.sh setup                         # Initialize directories
./foundry.sh preflight                     # Verify tools
./foundry.sh env-check                     # Verify environment
```

## Compatibility

- `make builder-setup` remains as a legacy alias
- Public entrypoints: `foundry.sh` and `ultraworks.sh` only
- Scripts under `lib/` are internal — do not call directly
