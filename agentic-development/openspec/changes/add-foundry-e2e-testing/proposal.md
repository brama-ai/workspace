# Add E2E Testing Infrastructure for Foundry Pipeline

**Change ID:** `add-foundry-e2e-testing`
**Status:** draft
**Created:** 2026-03-29
**Author:** u-architect

## Summary

Build comprehensive E2E tests for the Foundry pipeline that exercise full task lifecycles, supervisor health monitoring, and batch worker orchestration using real filesystem operations and mocked executor/git layers. This leverages the existing vitest + fixtures infrastructure already established in `monitor/src/__tests__/`.

## Motivation

### Problem

The Foundry pipeline was fully migrated to TypeScript (`batch.ts`, `retry.ts`, `cleanup.ts`, `preflight.ts`, `runner.ts`, `executor.ts`, `supervisor.ts`). Existing unit tests cover individual functions in isolation (e.g., `promoteNextTodoToPending`, `diagnose`, `checkStall`, `blacklistModel`), but there are no tests that exercise **multi-step workflows end-to-end**:

1. **No lifecycle integration tests** — Individual state transitions are tested, but no test drives a task through `todo → pending → in_progress → completed` via the actual `runPipeline()` + `promoteNextTodoToPending()` flow.
2. **No retry flow tests** — The `failed → todo → pending → in_progress` retry cycle is untested as an integrated sequence.
3. **No supervisor E2E tests** — `diagnose()` and `checkStall()` are unit-tested, but the supervisor's autonomous loop (detect stall → diagnose → write root-cause report → retry) has no integration coverage.
4. **No batch worker pool tests** — `promoteNextTodoToPending()` is tested, but the full worker spawn/claim/reap cycle and headless watch mode are untested.
5. **No mock executor** — Tests currently mock `executeAgent` inline per test file. A shared mock executor that simulates agent success/failure/HITL patterns would reduce duplication and enable richer E2E scenarios.

### Why Now

- All pipeline code is now TypeScript — no bash delegation barriers
- Existing test fixtures (`helpers/fixtures.ts`) provide `createTestRoot()`, `createTask()`, `appendEvent()`, `writeSummary()` — a solid foundation
- 17 test files already exist with established patterns (vitest, real tmpdir, mocked child_process)
- Adding features on top of untested E2E flows risks silent regressions

### Prior Art

The draft proposal at `proposals/foundry-e2e-agent-testing.md` proposed `@microsoft/tui-test`, Docker containers, and dedicated orchestrator/summarizer agents. This OpenSpec proposal takes a **simpler, pragmatic approach**: extend the existing vitest test suite with E2E test files that use the established fixture helpers and mock patterns, avoiding new dependencies and infrastructure.

## Scope

### In Scope

- **Test fixtures**: Extend `helpers/fixtures.ts` with git repo fixture, mock executor factory, and multi-task scenario builders
- **Pipeline lifecycle E2E tests**: Full `todo → pending → in_progress → completed` and retry flows via `runPipeline()` + state management
- **Supervisor E2E tests**: Stall detection → diagnosis → root-cause report → auto-retry loop
- **Batch worker E2E tests**: `promoteNextTodoToPending` with priorities/blocked_by, worker pool spawn/reap simulation, headless watch mode with mock timer, singleton lock contention

### Out of Scope

- TUI monitor visual testing (separate concern, needs `@microsoft/tui-test`)
- Real LLM calls or real `opencode` invocations
- Docker-based test isolation
- CI/CD pipeline integration (follow-up task)
- New npm dependencies (use vitest built-ins only)

## Impact

| Component | Impact |
|-----------|--------|
| `monitor/src/__tests__/helpers/fixtures.ts` | **MODIFIED** — Add git repo fixture, mock executor factory, multi-task builders |
| `monitor/src/__tests__/helpers/mock-executor.ts` | **NEW** — Shared mock executor with configurable agent behaviors |
| `monitor/src/__tests__/helpers/git-fixture.ts` | **NEW** — Temp git repo with branch management |
| `monitor/src/__tests__/e2e/pipeline-lifecycle.test.ts` | **NEW** — Full lifecycle E2E tests |
| `monitor/src/__tests__/e2e/supervisor-e2e.test.ts` | **NEW** — Supervisor autonomous loop tests |
| `monitor/src/__tests__/e2e/batch-worker.test.ts` | **NEW** — Batch worker pool E2E tests |
| `monitor/vitest.config.ts` | **MODIFIED** — Add E2E test timeout configuration |

## Constraints

- **vitest only** — No new test framework dependencies
- **Real filesystem** — Use `tmpdir()` for all test state, never mock `fs`
- **Mocked executor** — All `executeAgent` calls return deterministic results, no LLM calls
- **Mocked git** — Use temp git repos or mock `execSync` for git operations
- **< 60s total** — All E2E tests must complete within 60 seconds
- **Isolated** — Each test gets its own `createTestRoot()`, no shared state between tests

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Mock executor drift from real executor behavior | Medium | Type-check mock returns against `AgentResult` interface |
| Flaky tests from timing-dependent supervisor logic | Medium | Use `vi.useFakeTimers()` for all time-dependent tests |
| Test suite exceeds 60s budget | Low | Profile tests, parallelize with vitest's built-in concurrency |
| Batch worker tests need real child_process.spawn | Medium | Mock spawn, test orchestration logic not process management |
