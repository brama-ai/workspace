# Spec: E2E Test Infrastructure Helpers

**Capability:** `e2e-test-infrastructure`
**Parent Change:** `add-foundry-e2e-testing`

## ADDED Requirements

### Requirement: Mock executor factory
The system SHALL provide a shared `createMockExecutor()` factory in `helpers/mock-executor.ts` that returns a `vi.fn()` dispatching by agent name. The mock MUST satisfy the `AgentResult` TypeScript interface from `agents/executor.ts`. Pre-built behaviors (`successBehavior`, `failBehavior`, `hitlBehavior`, `timeoutBehavior`) SHALL be exported for reuse across E2E tests.

#### Scenario: Default success behavior
- **WHEN** `createMockExecutor()` is called with no arguments
- **THEN** the returned mock resolves with `AgentResult` where `success: true` and `exitCode: 0`
- **AND** the return value satisfies the `AgentResult` TypeScript interface

#### Scenario: Per-agent behavior dispatch
- **WHEN** `createMockExecutor({ "u-coder": successBehavior, "u-fail": failBehavior })` is called
- **THEN** calls with `config.name === "u-coder"` return success result
- **AND** calls with `config.name === "u-fail"` return failure result with `exitCode: 1`
- **AND** calls with unknown agent names use the default success behavior

#### Scenario: Call history tracking
- **WHEN** the mock executor is called multiple times with different agents
- **THEN** `mockExecutor.mock.calls` contains all calls in order
- **AND** each call record includes `[config, prompt, options]` arguments

#### Scenario: HITL behavior
- **WHEN** an agent configured with `hitlBehavior` is executed
- **THEN** result has `success: false`, `exitCode: 75`, `hitlWaiting: true`

#### Scenario: Timeout behavior
- **WHEN** an agent configured with `timeoutBehavior` is executed
- **THEN** result has `success: false`, `exitCode: 124`

### Requirement: Git fixture for temp repositories
The system SHALL provide a `createGitRepo()` function in `helpers/git-fixture.ts` that creates an isolated temporary git repository with `main` branch and initial commit. The fixture SHALL support branch creation, checkout, and commit operations. A `cleanup()` method SHALL remove the temp directory.

#### Scenario: Create temporary git repository
- **WHEN** `createGitRepo("test-")` is called
- **THEN** returns a `GitFixture` with `repoPath` pointing to a tmpdir
- **AND** the directory is a valid git repository with `main` branch
- **AND** at least one initial commit exists

#### Scenario: Create and checkout branch
- **WHEN** `fixture.createBranch("pipeline/my-task")` is called
- **THEN** branch `pipeline/my-task` exists in the repo
- **AND** `fixture.checkout("pipeline/my-task")` switches to that branch

#### Scenario: Create commit with files
- **WHEN** `fixture.commit("Add utils", { "src/utils.ts": "export const x = 1;" })` is called
- **THEN** file `src/utils.ts` exists with the given content
- **AND** a commit with message "Add utils" is created
- **AND** returns the commit SHA

#### Scenario: Cleanup removes temp directory
- **WHEN** `fixture.cleanup()` is called on an existing fixture
- **THEN** the temp directory no longer exists

### Requirement: Scenario builder helpers
The system SHALL extend `helpers/fixtures.ts` with scenario builders for common E2E test setups: multi-task scenarios with dependencies, retry scenarios with failed state, and stalled task scenarios with old events.

#### Scenario: Create multi-task scenario
- **WHEN** `createTaskScenario(root, [{ slug: "a", priority: 2 }, { slug: "b", priority: 1, blocked_by: ["a"] }])` is called
- **THEN** two task directories are created: `a--foundry/` and `b--foundry/`
- **AND** each has `state.json` with correct status, priority, and blocked_by fields
- **AND** each has `task.md` with task description

#### Scenario: Create retry scenario
- **WHEN** `createRetryScenario(root, "my-task", 2)` is called
- **THEN** task directory `my-task--foundry/` is created with `state.json` having `status: "failed"` and `attempt: 2`
- **AND** `events.jsonl` contains failure events

#### Scenario: Create stalled scenario
- **WHEN** `createStalledScenario(root, "stale-task", 25)` is called
- **THEN** task directory `stale-task--foundry/` is created with `state.json` having `status: "in_progress"` and `current_step: "u-coder"`
- **AND** `events.jsonl` has last event timestamp 25 minutes ago

### Requirement: Vitest E2E configuration
The vitest configuration SHALL include E2E test files from `src/__tests__/e2e/**/*.test.ts` and SHALL set an extended timeout for E2E tests.

#### Scenario: E2E tests are discovered
- **WHEN** `vitest run` is executed
- **THEN** both unit tests in `src/__tests__/*.test.ts` and E2E tests in `src/__tests__/e2e/*.test.ts` are discovered and run

#### Scenario: E2E tests have extended timeout
- **WHEN** an E2E test takes up to 30 seconds to complete
- **THEN** the test does not timeout
