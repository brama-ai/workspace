# Foundry E2E Agent Tests

End-to-end tests for Foundry multi-agent pipeline system.

## Overview

This test suite validates:
- ✅ Git workflow safety (branch creation, commits)
- ✅ Agent orchestration and state transitions
- ✅ Parallel worker coordination
- ✅ Task claiming atomicity
- ✅ Terminal interactions and CLI behavior

## Quick Start

### Option 1: Run in Isolated Docker Container (Recommended)

This ensures complete isolation - tasks won't interfere with your main Foundry instance:

```bash
# From this directory (agentic-development/tests/e2e-agents)
./run-e2e-tests.sh

# Run specific tests
./run-e2e-tests.sh --grep "git workflow"

# Keep containers running for debugging
E2E_CLEANUP=0 ./run-e2e-tests.sh
```

The isolated container uses:
- Empty `tasks-e2e-isolated/` directory (mounted separately)
- `FOUNDRY_TASK_ROOT=/workspaces/brama/tasks-e2e-isolated`
- `E2E_TEST_MODE=1` flag

Note: Foundry agents only use filesystem (tasks/, git) - no database needed.

### Option 2: Run Locally (Development)

For faster iteration during test development:

```bash
# From this directory (agentic-development/tests/e2e-agents)
npm install
npm test

# Run specific tests
npm test git-workflow

# Run smoke tests only
npm run test:smoke

# Run with UI
npm run test:ui

# Debug mode
npm run test:debug
```

⚠️ **Warning:** Local tests use `tasks-e2e-test/` directory but may still be picked up by your main Foundry instance if it's running!

## Test Structure

```
e2e-agents/
├── specs/                    # Test specifications
│   ├── git-workflow.spec.ts  # Git branch safety tests
│   └── ...                   # More test suites
├── fixtures/                 # Test fixtures and mocks
│   ├── tasks/               # Sample task.md files
│   └── mocks/               # Mock LLM responses
├── utils/                    # Test utilities
│   ├── test-helpers.ts      # Helper functions
│   ├── global-setup.ts      # Setup before all tests
│   └── global-teardown.ts   # Cleanup after all tests
└── playwright.config.ts      # Playwright configuration
```

## Writing Tests

### Example Test

```typescript
import { test, expect } from '@playwright/test';
import { exec, createTestTask, getCurrentBranch } from '../utils/test-helpers';

test('should do something', async () => {
  // Arrange
  const taskDir = createTestTask('# Test task\n\nDo something.');

  // Act
  const result = exec('./agentic-development/foundry.sh run --task-file task.md');

  // Assert
  expect(result.success).toBe(true);
});
```

### Available Helpers

```typescript
// Execute shell commands
const result = exec('git status');
expect(result.success).toBe(true);
expect(result.stdout).toContain('On branch');

// Create test tasks
const taskDir = createTestTask('# My task', { slug: 'my-task', priority: 3 });

// Get task state
const state = getTaskState(taskDir);
expect(state.status).toBe('completed');

// Wait for state
await waitForTaskState(taskDir, (s) => s.status === 'in_progress');

// Git operations
const branch = getCurrentBranch();
const exists = branchExists('pipeline/test');
const commits = getCommits(5); // last 5 commits
```

## Test Isolation

Tests run in isolation using:
1. **Isolated container** (recommended): `docker-compose.e2e.yml` with empty `tasks-e2e-isolated/` mount
2. **Separate task directory**: `tasks-e2e-test/` (local) or `tasks-e2e-isolated/` (container)
3. **Test branch prefix**: `e2e-test/*` for easy cleanup
4. **Sequential execution**: One test at a time to avoid git conflicts
5. **Environment variables**: `FOUNDRY_TASK_ROOT` and `E2E_TEST_MODE=1`

## Current Test Coverage

### Git Workflow Safety (@smoke)
- ✅ Prevents creating task branch from non-main branch
- ✅ Allows creating task branch from main branch
- ✅ Detects current branch correctly
- ✅ Checks git state before running
- ✅ Uses correct branch naming convention

### Git Branch Management
- ✅ Verifies git installation
- ✅ Detects main branch name
- ✅ Lists existing branches

### Task Lifecycle
- ✅ Creates task with correct initial structure
- ✅ Finds pending tasks via filesystem
- ✅ Lists tasks by filesystem directory scan
- ✅ Validates task file format

### Task State Management
- ✅ Creates state.json when task is claimed
- ✅ Tracks state transitions (pending → in_progress → completed)
- ✅ Validates state.json schema

### Parallel Tasks
- ✅ Handles multiple pending tasks
- ✅ Tracks worker assignment for parallel tasks

### Foundry CLI Commands (@smoke)
- ✅ Creates tasks using foundry_create_task_dir
- ✅ Creates multiple tasks and tracks them
- ✅ Gets Foundry status with task counts
- ✅ Validates task directory structure
- ✅ Handles markdown formatting and special characters

### Task Execution by Agents (⚠️ Requires Isolated Container)
- ✅ Executes simple task and generates summary
- ✅ Tracks task state transitions during execution
- ✅ Handles tasks with multiple requirements
- ✅ Fails tasks gracefully when requirements cannot be met
- ✅ Runs task through full agent pipeline

**Total: 45+ tests**

## Next Steps

Future test suites to add:
- [ ] TUI monitor interactions
- [ ] Error handling and recovery
- [ ] Webhook notifications
- [ ] Multi-worker parallel execution

## Troubleshooting

### "Not on main branch" warning
This is expected if you're currently working on a feature branch. Tests will adapt and verify the safety checks instead.

### Test branches not cleaned up
Run manually:
```bash
git branch -D $(git branch --list "e2e-test/*" | tr -d " ")
```

### Tests failing locally
Make sure you're in the e2e-agents directory:
```bash
cd agentic-development/tests/e2e-agents
npm test
```

## CI/CD

Tests can be integrated into GitHub Actions:

```yaml
- name: Run Foundry E2E Tests
  run: |
    cd agentic-development/tests/e2e-agents
    npm install
    npm test
```

## Contributing

When adding new tests:
1. Create test file in `specs/` with `*.spec.ts` suffix
2. Use `@smoke` tag for critical path tests
3. Add cleanup in `afterEach` hook
4. Use helpers from `utils/test-helpers.ts`
5. Document new test coverage in this README

---

**Status:** ✅ MVP Complete
**Last Updated:** 2026-03-25
