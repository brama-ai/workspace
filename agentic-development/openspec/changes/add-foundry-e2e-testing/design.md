# Design: E2E Testing Infrastructure for Foundry Pipeline

## Problem

The Foundry pipeline has 17 unit test files covering individual functions, but no tests exercise multi-step workflows end-to-end. This leaves integration gaps in lifecycle transitions, supervisor health loops, and batch worker orchestration.

## Approach

Extend the existing vitest test suite with a new `__tests__/e2e/` directory containing integration tests that compose multiple pipeline modules together. Reuse and extend the existing `helpers/fixtures.ts` pattern. Mock at the executor boundary (no real LLM calls) and git boundary (temp repos or mocked `execSync`).

### Architecture

```
__tests__/
├── helpers/
│   ├── fixtures.ts          # EXISTING — extend with scenario builders
│   ├── mock-executor.ts     # NEW — configurable mock executor factory
│   └── git-fixture.ts       # NEW — temp git repo management
├── e2e/
│   ├── pipeline-lifecycle.test.ts  # NEW — full lifecycle flows
│   ├── supervisor-e2e.test.ts      # NEW — supervisor autonomous loop
│   └── batch-worker.test.ts        # NEW — batch worker pool
├── lifecycle.test.ts        # EXISTING — unit tests (unchanged)
├── supervisor.test.ts       # EXISTING — unit tests (unchanged)
└── ...                      # EXISTING — other unit tests (unchanged)
```

### Key Design Decisions

#### 1. Mock at the executor boundary

**Decision:** Mock `executeAgent()` from `agents/executor.ts`, not individual modules.

**Reasoning:** The executor is the natural boundary between pipeline orchestration (what we want to test) and external system calls (what we want to avoid). This is already the pattern used in `runner.test.ts`:

```typescript
vi.mock("../agents/executor.js", () => ({
  executeAgent: vi.fn(async (config, prompt, options) => { ... }),
}));
```

The E2E tests will use a shared `createMockExecutor()` factory that returns configurable agent behaviors:

```typescript
// helpers/mock-executor.ts
export function createMockExecutor(behaviors: Record<string, AgentBehavior>) {
  return vi.fn(async (config, prompt, options) => {
    const behavior = behaviors[config.name] ?? defaultSuccess;
    return behavior(config, prompt, options);
  });
}
```

**Alternatives considered:**
- Mock at the `opencode` CLI level — too low-level, would need to mock shell execution
- Mock at the `runPipeline` level — too high-level, would skip the orchestration logic we want to test
- No mocking (real LLM calls) — violates constraints (cost, speed, determinism)

#### 2. Real filesystem, mocked git

**Decision:** Use real tmpdir for task state files. For git operations, provide two options:
1. `git-fixture.ts` — creates a real temp git repo for tests that need branch/commit verification
2. Mock `execSync` — for tests that only need git to not fail

**Reasoning:** The existing test suite already uses real filesystem (`createTestRoot()`, `createTask()`). Git fixtures are needed because `batch.ts` and `supervisor.ts` interact with git worktrees and branches. A real temp git repo is more reliable than mocking every git command.

**Alternatives considered:**
- Mock all filesystem operations — rejected, existing pattern uses real fs and it works well
- Use `memfs` — rejected, adds dependency and doesn't match existing patterns
- Always use real git repos — rejected, too slow for tests that don't need git

#### 3. Fake timers for supervisor tests

**Decision:** Use `vi.useFakeTimers()` for all supervisor and batch worker tests that involve polling, stall detection, or watch mode.

**Reasoning:** The supervisor polls on intervals (default 180s) and detects stalls based on time since last event. Real timers would make tests either slow (waiting for real intervals) or flaky (race conditions). Vitest's fake timers allow deterministic control:

```typescript
vi.useFakeTimers();
// ... set up stale event
vi.advanceTimersByTime(25 * 60 * 1000); // simulate 25 min passing
const result = checkStall(taskDir, "in_progress", "u-coder");
expect(result.stalled).toBe(true);
```

This pattern is already used in `executor.test.ts` for blacklist TTL testing.

#### 4. E2E tests in separate directory

**Decision:** Place E2E tests in `__tests__/e2e/` subdirectory, not alongside unit tests.

**Reasoning:**
- Clear separation of test types (unit vs integration/E2E)
- Can configure different timeouts in vitest config
- Can run E2E tests separately: `vitest run --dir src/__tests__/e2e`
- Existing unit tests remain untouched

#### 5. No new dependencies

**Decision:** Use only vitest built-ins. No `@microsoft/tui-test`, no `proper-lockfile`, no test containers.

**Reasoning:** The existing test infrastructure is sufficient. The original proposal at `proposals/foundry-e2e-agent-testing.md` suggested `@microsoft/tui-test` for TUI testing, but the current scope focuses on pipeline logic, not terminal rendering. Adding dependencies increases maintenance burden and CI complexity.

## Component Interactions

### Pipeline Lifecycle E2E Flow

```
Test Setup:
  createTestRoot() → tmpdir
  createTask(root, "my-task", { status: "todo" })
  vi.mock("../agents/executor.js") → mock executor

Test Flow:
  1. promoteNextTodoToPending()     → state: todo → pending
  2. runPipeline(config)            → state: pending → in_progress
     ├── executeAgent("u-coder")    → mock returns success
     ├── executeAgent("u-validator")→ mock returns success
     └── executeAgent("u-summarizer")→ mock returns success
  3. Assert state.json              → status: "completed"
  4. Assert events.jsonl            → AGENT_START/END events logged
  5. Assert artifacts/              → agent logs created
```

### Supervisor E2E Flow

```
Test Setup:
  createTestRoot() → tmpdir
  createTask(root, "stale-task", { status: "in_progress" })
  Write old event (25 min ago) to events.jsonl
  vi.mock("../agents/executor.js") → mock executor

Test Flow:
  1. checkStall(taskDir)            → stalled: true
  2. diagnose(taskDir, state)       → category: "timeout"
  3. Write root-cause-N.md          → file created
  4. setStateStatus("todo")         → retry: back to todo
  5. promoteNextTodoToPending()     → state: todo → pending
  6. runPipeline(retryConfig)       → mock executor succeeds
  7. Assert state.json              → status: "completed", attempt: 2
```

### Batch Worker E2E Flow

```
Test Setup:
  createTestRoot() → tmpdir
  createTask(root, "task-1", { status: "todo", priority: 2 })
  createTask(root, "task-2", { status: "todo", priority: 1 })
  createTask(root, "task-3", { status: "todo", blocked_by: ["task-1"] })

Test Flow:
  1. promoteNextTodoToPending()     → promotes task-1 (highest priority)
  2. Assert task-2 still todo       → single-slot gate
  3. Assert task-3 still todo       → blocked by task-1
  4. Simulate task-1 completion     → setStateStatus("completed")
  5. promoteNextTodoToPending()     → promotes task-3 (dep resolved) or task-2
  6. Assert correct promotion order
```

## Data Model

No new data models. Tests use the existing `TaskState` interface from `state/task-state-v2.ts` and `AgentResult` from `agents/executor.ts`.

### Mock Executor Types

```typescript
// helpers/mock-executor.ts

interface AgentBehavior {
  (config: AgentConfig, prompt: string, options: any): Promise<AgentResult>;
}

interface MockExecutorConfig {
  /** Per-agent behavior overrides */
  behaviors?: Record<string, AgentBehavior>;
  /** Default behavior for unspecified agents */
  defaultBehavior?: AgentBehavior;
  /** Track call history */
  callLog?: AgentCallRecord[];
}

interface AgentCallRecord {
  agent: string;
  prompt: string;
  timestamp: number;
  result: AgentResult;
}
```

### Git Fixture Types

```typescript
// helpers/git-fixture.ts

interface GitFixture {
  /** Path to temp git repo */
  repoPath: string;
  /** Create a branch from current HEAD */
  createBranch(name: string): void;
  /** Checkout a branch */
  checkout(name: string): void;
  /** Create a commit with given files */
  commit(message: string, files?: Record<string, string>): string;
  /** Cleanup temp repo */
  cleanup(): void;
}
```

## API Surface

No new public APIs. All additions are test-only helpers and test files.

## Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Mock executor doesn't match real `AgentResult` shape | Tests pass but miss real bugs | Use TypeScript strict typing — mock must satisfy `AgentResult` interface |
| Supervisor E2E tests become flaky with fake timers | CI failures, developer frustration | Isolate timer-dependent logic, use `vi.advanceTimersByTime()` deterministically |
| Batch worker tests need real `spawn()` for worker processes | Can't test actual parallelism | Test orchestration logic (promote, claim, release) not process management |
| Git fixture cleanup fails on CI | Leftover temp dirs | Use `afterEach` with `rmSync({ force: true })`, same as existing tests |
