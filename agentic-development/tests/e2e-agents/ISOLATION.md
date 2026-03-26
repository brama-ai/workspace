# E2E Test Isolation

## Problem

E2E tests were creating tasks in directories that would be picked up by the main Foundry pipeline, causing:
1. Test tasks being executed by production agents
2. Test artifacts appearing in main `tasks/` directory
3. Interference between test runs and real work

## Solution

### 1. Isolated Docker Container (Recommended)

**Files:**
- [`docker-compose.e2e.yml`](./docker-compose.e2e.yml) - Separate container configuration
- [`run-e2e-tests.sh`](./run-e2e-tests.sh) - Test runner script

**How it works:**
```bash
./run-e2e-tests.sh
```

- Starts isolated container
- Mounts empty `tasks-e2e-isolated/` directory
- Sets `FOUNDRY_TASK_ROOT=/workspaces/brama/tasks-e2e-isolated`
- Sets `E2E_TEST_MODE=1` flag
- Cleans up after tests complete

**Isolation guarantees:**
- ✅ Empty task directory (no interference with main tasks/)
- ✅ Independent Foundry instance
- ✅ Separate filesystem namespace
- ✅ No impact on main development environment

**Note:** Foundry agents only use filesystem (tasks/, git) - no database/Redis needed.

### 2. Local Development (Fallback)

**Files modified:**
- [`utils/test-helpers.ts`](./utils/test-helpers.ts) - Reads `FOUNDRY_TASK_ROOT` from env
- [`utils/global-setup.ts`](./utils/global-setup.ts) - Creates isolated task directory
- [`utils/global-teardown.ts`](./utils/global-teardown.ts) - Cleans up after tests

**How it works:**
```bash
npm test
```

- Uses `tasks-e2e-test/` directory by default
- Tests prefixed with `e2e-test/*` branch naming
- Sequential execution to avoid conflicts

**⚠️ Warning:** Even with separate directory, if main Foundry is watching file system changes, it might still pick up test tasks.

## Environment Variables

### `FOUNDRY_TASK_ROOT`
Overrides the default `tasks/` directory location.

```bash
export FOUNDRY_TASK_ROOT=/path/to/isolated/tasks
```

Test helpers automatically use this when set:
```typescript
export const TEST_TASKS_DIR = process.env.FOUNDRY_TASK_ROOT || path.join(REPO_ROOT, 'tasks-e2e-test');
```

### `E2E_TEST_MODE`
Signals to Foundry agents that they're running in test mode.

```bash
export E2E_TEST_MODE=1
```

This can be used by agents to:
- Skip certain validations
- Use mock LLM responses
- Generate faster/simpler outputs
- Avoid real external API calls

## Test Categories

### Fast Tests (No Agent Execution)
These tests run quickly and don't need the isolated container:
- Git workflow safety checks
- Task lifecycle state management
- CLI command validation
- Task structure verification

**Run locally:**
```bash
npm test -- --grep "Git Workflow|Task Lifecycle|CLI Commands"
```

### Slow Tests (Agent Execution Required)
These tests actually run Foundry agents and require isolation:
- Task execution by agents
- Full pipeline integration
- Summary generation
- Multi-agent coordination

**Run in isolated container:**
```bash
./run-e2e-tests.sh --grep "Task Execution|Agent Pipeline"
```

## Cleanup

### Manual cleanup if needed:
```bash
# Remove test tasks from main directory
rm -rf tasks/*-e2e-test*

# Clean test branches
git branch -D $(git branch --list "e2e-test/*" | tr -d " ")

# Remove test task directories
rm -rf tasks-e2e-test/
rm -rf agentic-development/tests/e2e-agents/tasks-e2e-isolated/
```

### Stop isolated containers:
```bash
cd agentic-development/tests/e2e-agents
docker compose -f docker-compose.e2e.yml down
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Development Environment (devcontainer)                     │
│                                                              │
│  ┌─────────────┐                                            │
│  │ Main Foundry│ ──▶ tasks/                                 │
│  │  Pipeline   │     (production tasks)                     │
│  └─────────────┘                                            │
│                                                              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  E2E Test Container (docker-compose.e2e.yml)                │
│                                                              │
│  ┌─────────────┐     FOUNDRY_TASK_ROOT=                     │
│  │ Test Foundry│ ──▶ /workspaces/brama/tasks-e2e-isolated/ │
│  │  Pipeline   │     (empty on startup)                     │
│  └─────────────┘                                            │
│                                                              │
│  Note: Only filesystem isolation needed                     │
│  (Foundry agents don't use databases)                       │
└─────────────────────────────────────────────────────────────┘
```

## Benefits

1. **Complete Isolation**: Test tasks never interfere with real work
2. **Reproducible**: Empty directory on every test run
3. **Parallel Development**: Tests can run while you develop
4. **Safe Cleanup**: Containers can be destroyed without affecting dev environment
5. **CI/CD Ready**: Easy to integrate into automated pipelines

## Future Improvements

- [ ] Mock LLM responses when `E2E_TEST_MODE=1`
- [ ] Snapshot testing for agent outputs
- [ ] Performance benchmarking
- [ ] Multi-worker parallel execution tests
- [ ] Network isolation (no external API calls in tests)
