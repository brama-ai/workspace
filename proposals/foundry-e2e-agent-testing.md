# Proposal: E2E Testing Infrastructure for Foundry Agents

**Status:** Draft
**Created:** 2026-03-25
**Author:** System
**Priority:** High

---

## Executive Summary

Implement comprehensive E2E testing infrastructure for Foundry multi-agent pipeline system using **@microsoft/tui-test** framework. This will enable automated validation of agent behavior, pipeline orchestration, and terminal interactions in isolated test environments.

---

## Problem Statement

### Current State
- Foundry pipeline has **16 agents** (u-architect, u-coder, u-validator, u-tester, etc.)
- Manual testing of agent workflows is time-consuming and error-prone
- No automated validation of:
  - Agent prompt generation and context handling
  - Pipeline state transitions (pending → in_progress → completed/failed)
  - Git workflow safety (branch creation, commits, merges)
  - Terminal output and user interactions
  - Worker parallelization and task claiming
- Regression risks when modifying core pipeline logic

### Risks Without E2E Testing
- Silent failures in agent orchestration
- Git workflow regressions (e.g., branching from wrong base)
- State corruption in parallel worker scenarios
- Breaking changes to agent prompts/contracts
- Terminal UI regressions in Foundry monitor

---

## Proposed Solution

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    E2E Test Orchestrator                     │
│                  (e2e-orchestrator agent)                    │
│  - Creates test scenarios                                    │
│  - Manages test lifecycle                                    │
│  - Coordinates test execution in isolation                   │
└───────────────┬─────────────────────────────────────────────┘
                │
                ├─────────> Test Execution Environment
                │            (Docker container with:
                │             - isolated git repo
                │             - test task files
                │             - mock LLM responses)
                │
                ├─────────> TUI Test Runner
                │            (@microsoft/tui-test)
                │            - Terminal interaction validation
                │            - Screenshot capture
                │            - Output assertions
                │
                └─────────> E2E Summarizer Agent
                             (e2e-summarizer agent)
                             - Analyzes test results
                             - Generates failure reports
                             - Creates fix tasks
```

### Components

#### 1. **E2E Test Orchestrator Agent** (`e2e-orchestrator`)
**Prefix:** `e2e-orchestrator`
**Role:** Create and manage test scenarios

**Responsibilities:**
- Generate test case definitions (task.md files with test directives)
- Set up test fixtures (mock repos, state files, handoff templates)
- Configure test isolation (separate git worktrees, temp directories)
- Define expected outcomes and assertions
- Coordinate with test runner

**Implementation:**
```bash
.opencode/agents/e2e-orchestrator.md
agentic-development/lib/foundry-e2e-orchestrator.sh
```

**Example Test Scenario:**
```yaml
test_name: "simple_coder_task"
description: "u-coder completes basic feature implementation"
agents: [u-coder, u-summarizer]
task: "Add hello() function to utils.ts"
assertions:
  - file_exists: "src/utils.ts"
  - contains: "export function hello()"
  - git_commits: 2  # coder + summarizer
  - state_status: "completed"
  - no_errors: true
```

#### 2. **E2E Test Runner** (`e2e-runner`)
**Technology:** @microsoft/tui-test + TypeScript
**Location:** `agentic-development/tests/e2e-agents/`

**Features:**
- Terminal context isolation per test
- TUI interaction validation (for Foundry monitor testing)
- Stdout/stderr capture and assertions
- Screenshot snapshots for terminal output
- Trace recording for debugging
- Parallel test execution with full isolation

**Example Test:**
```typescript
// agentic-development/tests/e2e-agents/basic-pipeline.spec.ts
import { test, expect } from '@microsoft/tui-test';

test('u-coder creates feature branch and commits', async ({ terminal }) => {
  // Arrange: create test task
  await terminal.exec('./foundry.sh run --task-file /tmp/test-task.md');

  // Assert: wait for completion
  await terminal.waitForText('✓ Committed:', { timeout: 120000 });

  // Verify git state
  const branches = await terminal.exec('git branch --show-current');
  expect(branches.stdout).toMatch(/^pipeline\//);

  // Take screenshot for visual regression
  await terminal.screenshot('u-coder-success.png');
});

test('parallel workers claim tasks atomically', async ({ terminal }) => {
  // Create 5 test tasks
  for (let i = 0; i < 5; i++) {
    await terminal.exec(`echo "# Task ${i}" > tasks/test-${i}--foundry/task.md`);
  }

  // Start 3 workers
  await terminal.exec('./foundry.sh batch --workers 3');

  // Assert: all tasks claimed exactly once
  await terminal.waitForText('5 tasks completed', { timeout: 300000 });

  // Verify no race conditions in state.json
  const states = await getTaskStates();
  expect(states.every(s => s.worker_id !== null)).toBe(true);
  expect(new Set(states.map(s => s.worker_id)).size).toBe(3);
});
```

#### 3. **E2E Summarizer Agent** (`e2e-summarizer`)
**Prefix:** `e2e-summarizer`
**Role:** Analyze test results and generate reports

**Responsibilities:**
- Parse @microsoft/tui-test trace files
- Generate human-readable failure summaries
- Create Foundry fix tasks for failures (similar to existing e2e-autofix)
- Track test flakiness and patterns
- Update test documentation

**Implementation:**
```bash
.opencode/agents/e2e-summarizer.md
agentic-development/lib/foundry-e2e-summarizer.sh
```

---

## Test Isolation Strategy

### Problem: Avoiding Conflicts with Production Foundry

**Risk:** E2E tests running in the same repo could interfere with active Foundry tasks.

### Solution: Containerized Test Environment

```dockerfile
# agentic-development/tests/e2e-agents/Dockerfile
FROM mcr.microsoft.com/devcontainers/base:ubuntu

# Install dependencies
RUN apt-get update && apt-get install -y git nodejs npm

# Copy repo snapshot (not mounted)
COPY . /test-repo
WORKDIR /test-repo

# Initialize clean git state
RUN git config user.name "E2E Test" && \
    git config user.email "e2e@test.local"

# Install test dependencies
WORKDIR /test-repo/agentic-development/tests/e2e-agents
RUN npm install

# Entry point runs tests in isolation
ENTRYPOINT ["npm", "test"]
```

### Alternative: Dedicated Test Worktree

For local development without Docker overhead:

```bash
# Create persistent test worktree
git worktree add .foundry-e2e-test main

# Run tests in isolated worktree
cd .foundry-e2e-test
FOUNDRY_TASK_ROOT="$(pwd)/tasks-test" \
./agentic-development/foundry.sh run --task-file test.md
```

---

## Implementation Plan

### Phase 1: Foundation (Week 1)
- [ ] Install and configure @microsoft/tui-test
- [ ] Create test directory structure:
  ```
  agentic-development/tests/e2e-agents/
  ├── tui-test.config.ts
  ├── fixtures/
  │   ├── tasks/
  │   ├── repos/
  │   └── mocks/
  ├── specs/
  │   ├── basic-pipeline.spec.ts
  │   ├── git-workflow.spec.ts
  │   └── parallel-workers.spec.ts
  └── utils/
      ├── test-helpers.ts
      └── assertions.ts
  ```
- [ ] Create Docker container for test isolation
- [ ] Implement basic test runner script

### Phase 2: Core Tests (Week 2)
- [ ] Test git workflow safety:
  - Branch creation from main only
  - Commit message format
  - No uncommitted changes
- [ ] Test state transitions:
  - pending → in_progress → completed
  - Task claiming atomicity
  - State file integrity
- [ ] Test single-agent workflows:
  - u-coder creates files
  - u-validator runs checks
  - u-summarizer generates summary

### Phase 3: E2E Orchestrator Agent (Week 3)
- [ ] Create e2e-orchestrator.md agent definition
- [ ] Implement test scenario DSL (YAML/JSON)
- [ ] Add test fixture generation
- [ ] Integrate with test runner

### Phase 4: E2E Summarizer Agent (Week 3-4)
- [ ] Create e2e-summarizer.md agent definition
- [ ] Implement trace parsing
- [ ] Add failure report generation
- [ ] Integrate with Foundry task creation

### Phase 5: Advanced Tests (Week 4)
- [ ] Test parallel worker coordination
- [ ] Test agent failure recovery
- [ ] Test webhook notifications
- [ ] Test TUI monitor interactions
- [ ] Test resource cleanup

### Phase 6: CI/CD Integration (Week 5)
- [ ] Add GitHub Actions workflow
- [ ] Configure test sharding
- [ ] Set up test reporting
- [ ] Add flakiness tracking

---

## Integration with Foundry

### New CLI Commands

```bash
# Run all E2E agent tests
./agentic-development/foundry.sh e2e-agents

# Run specific test suite
./agentic-development/foundry.sh e2e-agents --suite git-workflow

# Run in watch mode (for development)
./agentic-development/foundry.sh e2e-agents --watch

# Generate test scenarios using orchestrator agent
./agentic-development/foundry.sh e2e-agents --generate

# Analyze test failures and create fix tasks
./agentic-development/foundry.sh e2e-agents --analyze-failures
```

### Foundry Flag

Add `--e2e-test-mode` flag to foundry-run.sh:

```bash
# Disable real LLM calls, use mocks from test fixtures
./agentic-development/foundry.sh run \
  --task-file test.md \
  --e2e-test-mode
```

This enables:
- Mock LLM responses from fixture files
- Deterministic test execution
- Faster test runs (no API latency)
- No API costs

---

## Mock LLM Strategy

### Problem
E2E tests need predictable agent responses without real API calls.

### Solution: Fixture-Based Mocking

```typescript
// fixtures/mocks/u-coder-responses.json
{
  "task": "Add hello() function to utils.ts",
  "response": {
    "files_written": ["src/utils.ts"],
    "content": "export function hello(name: string) { return `Hello, ${name}!`; }",
    "summary": "Added hello() function to utils.ts"
  }
}
```

```bash
# foundry-run.sh checks for --e2e-test-mode
if [[ "$E2E_TEST_MODE" == true ]]; then
  # Use local mock instead of opencode CLI
  mock_response=$(jq -r '.response.content' "$MOCK_DIR/${agent}.json")
  echo "$mock_response" > "$OUTPUT_FILE"
else
  # Normal execution with real LLM
  opencode agent "$agent" --prompt "$prompt"
fi
```

---

## Success Metrics

### Coverage Goals
- [ ] **90%+ critical path coverage** (main pipeline flows)
- [ ] **All git workflow scenarios** tested
- [ ] **All state transitions** validated
- [ ] **Parallel worker edge cases** covered

### Quality Goals
- [ ] **< 5% test flakiness** rate
- [ ] **< 10min** full E2E suite execution time
- [ ] **Zero** production incidents from untested agent changes

### Developer Experience
- [ ] **< 30sec** to run smoke tests locally
- [ ] **Clear failure messages** with actionable next steps
- [ ] **Visual diffs** for terminal output regressions

---

## Cost & Resource Estimates

### Development Effort
- **Phase 1-2:** 1 week (setup + core tests)
- **Phase 3-4:** 1 week (orchestrator + summarizer agents)
- **Phase 5-6:** 1 week (advanced tests + CI/CD)
- **Total:** ~3 weeks for MVP

### Infrastructure
- **Docker registry space:** ~500MB for test container image
- **GitHub Actions minutes:** ~50min/day for E2E runs
- **Storage:** ~1GB for test traces and screenshots

### Maintenance
- **Weekly:** Update tests for new agent features (~2hrs)
- **Monthly:** Review flakiness reports and optimize (~4hrs)

---

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|------|--------|------------|------------|
| Test flakiness due to timing | High | Medium | Use tui-test's built-in waits, increase timeouts for slow operations |
| Docker overhead slows tests | Medium | Low | Offer worktree-based local testing, optimize container caching |
| Mock drift from real agents | High | Medium | Generate mocks from real agent runs, validate periodically |
| Test maintenance burden | Medium | Medium | Auto-generate tests from orchestrator agent, clear ownership |

---

## Alternatives Considered

### 1. **Playwright for Terminal Testing**
**Pros:** Familiar to team, mature ecosystem
**Cons:** Not designed for terminal/TUI testing, lacks pty support
**Decision:** tui-test is purpose-built for this use case

### 2. **Manual Testing Only**
**Pros:** No initial investment
**Cons:** Does not scale, high risk of regressions
**Decision:** Manual testing insufficient for 16-agent system

### 3. **Unit Tests Only**
**Pros:** Fast, focused
**Cons:** Misses integration issues, git workflow bugs, state races
**Decision:** E2E tests complement (not replace) unit tests

---

## Open Questions

1. **Should e2e-orchestrator be an agent or a script?**
   - **Recommendation:** Start as agent for consistency, allows LLM to generate creative test scenarios

2. **How to handle long-running tests (e.g., 5min pipeline)?**
   - **Recommendation:** Use test sharding, run slow tests nightly, fast tests on PR

3. **What's the strategy for testing agent prompt changes?**
   - **Recommendation:** Version fixtures per agent version, run regression suite on prompt updates

4. **Should we test monitor TUI or just CLI?**
   - **Recommendation:** Phase 1 focuses on CLI, Phase 5 adds monitor TUI tests

---

## Next Steps

1. **Review & Approve Proposal** ← You are here
2. **Spike: tui-test POC** (2 days)
   - Install framework
   - Write 1-2 basic tests
   - Validate Docker isolation
3. **Create Implementation Tasks**
   - Break down phases into Foundry tasks
   - Assign ownership
4. **Begin Phase 1** (Week 1)

---

## References

- [microsoft/tui-test GitHub](https://github.com/microsoft/tui-test)
- [tui-test NPM Package](https://www.npmjs.com/package/@microsoft/tui-test)
- [Existing E2E autofix](agentic-development/lib/foundry-e2e.sh) (web tests)
- [Foundry Architecture](agentic-development/lib/foundry-run.sh)
- [Agent Definitions](.opencode/agents/)

---

## Appendix: Example Test Scenarios

### Scenario 1: Git Branch Safety
```typescript
test('prevents creating task branch from non-main branch', async ({ terminal }) => {
  // Arrange: checkout feature branch
  await terminal.exec('git checkout -b feature/test');

  // Act: try to start pipeline
  const result = await terminal.exec(
    './foundry.sh run --task-file test-task.md',
    { expectError: true }
  );

  // Assert: error message about wrong branch
  expect(result.stderr).toContain('must be on main');
  expect(result.exitCode).toBe(1);
});
```

### Scenario 2: State Transition Integrity
```typescript
test('task state transitions correctly through pipeline', async ({ terminal }) => {
  // Create test task
  const taskDir = await createTestTask('Simple feature');

  // Start pipeline
  await terminal.exec('./foundry.sh run --task-file ${taskDir}/task.md');

  // Assert state progression
  await waitForState(taskDir, 'in_progress');
  await terminal.waitForText('u-coder');

  await waitForState(taskDir, 'in_progress', 'u-validator');
  await terminal.waitForText('u-summarizer');

  await waitForState(taskDir, 'completed');

  // Verify final state file
  const state = JSON.parse(readFile(`${taskDir}/state.json`));
  expect(state.status).toBe('completed');
  expect(state.branch).toMatch(/^pipeline\//);
});
```

### Scenario 3: Parallel Worker Atomicity
```typescript
test('workers never double-claim tasks', async ({ terminal }) => {
  // Create 10 fast tasks
  const taskDirs = await createTestTasks(10, 'Quick task');

  // Start 5 workers simultaneously
  await terminal.exec('./foundry.sh batch --workers 5 --no-stop-on-failure');

  // Wait for all completions
  await terminal.waitForText('10 tasks completed', { timeout: 600000 });

  // Verify each task claimed exactly once
  const claimCounts = new Map<string, number>();

  for (const dir of taskDirs) {
    const state = JSON.parse(readFile(`${dir}/state.json`));
    const workerId = state.worker_id;
    claimCounts.set(workerId, (claimCounts.get(workerId) || 0) + 1);
  }

  // Each worker should have 2 tasks (10 tasks / 5 workers)
  expect(Array.from(claimCounts.values()).every(c => c === 2)).toBe(true);
});
```

---

**End of Proposal**
