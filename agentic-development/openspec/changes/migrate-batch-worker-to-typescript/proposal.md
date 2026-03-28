# Migrate foundry-batch.sh Worker Pool to TypeScript

**Change ID:** `migrate-batch-worker-to-typescript`
**Status:** draft
**Created:** 2026-03-28
**Author:** u-architect

## Summary

Port the parallel batch worker pool from bash (`foundry-batch.sh` + worker functions in `foundry-common.sh`) to TypeScript, creating a native TS module that integrates with the existing `task-state-v2.ts` state layer and `runner.ts` / `executor.ts` pipeline execution.

## Motivation

### Problem

The current batch worker pool is implemented in ~300 lines of bash (`foundry-batch.sh`) plus ~250 lines of worker-related functions in `foundry-common.sh`. The `foundry.ts` CLI delegates to these bash scripts via `runBashLib()` and `execSync(nohup ...)` for the `batch` and `headless` commands. This creates several problems:

1. **Dual runtime** — The TS CLI (`foundry.ts`) shells out to bash for batch/headless, creating a process boundary that loses type safety, error context, and structured telemetry.
2. **State divergence** — Bash scripts use raw `jq` mutations on `state.json` while TS uses `task-state-v2.ts`. Two codepaths for the same state file risk race conditions and semantic drift.
3. **No structured error handling** — Bash worker failures are communicated via exit codes and string parsing. TS can provide typed `AgentResult` objects with telemetry.
4. **Difficult to extend** — Adding features like dynamic worker scaling, health-based rebalancing, or structured logging requires fighting bash's limitations.
5. **Testing gap** — The bash batch code has no unit tests. TS code can be tested with vitest alongside existing test suites.

### Why Now

The TS monitor codebase (`agentic-development/monitor/`) has matured to the point where all the building blocks exist:
- `task-state-v2.ts` — full task state CRUD with typed interfaces
- `runner.ts` — pipeline execution with agent sequencing
- `executor.ts` — agent execution with timeout, retry, fallback chains
- `infra/git.ts` — git worktree management (add, remove, list, prune)
- `state/events.ts` — structured event logging

The batch worker is the last major bash component that the TS CLI delegates to. Migrating it completes the TS-native pipeline.

## Scope

### In Scope

- Worker pool class with configurable parallelism
- File-based locking for atomic task claiming (flock equivalent)
- Watch mode with configurable polling interval
- Dynamic worker count scaling (read from `monitor-workers` config file)
- Singleton lock (prevent multiple batch instances)
- SIGTERM/SIGINT graceful shutdown (cleanup worktrees, cancel orphaned tasks)
- Integration with existing `task-state-v2.ts` for all state operations
- Integration with existing `runner.ts` → `executor.ts` for pipeline execution
- Update `foundry.ts` CLI to use native TS batch/headless commands
- Todo-to-pending promotion logic

### Out of Scope

- Migrating other bash scripts (retry, stats, cleanup, setup, e2e)
- Changing the task directory structure or state.json schema
- Modifying the TUI monitor
- Changing the `opencode run` agent invocation mechanism
- Migrating `foundry-common.sh` functions not related to batch/worker operations

## Impact

| Component | Impact |
|-----------|--------|
| `monitor/src/cli/batch.ts` | **NEW** — Main batch worker module |
| `monitor/src/cli/foundry.ts` | **MODIFIED** — Replace bash delegation with TS imports |
| `monitor/src/infra/git.ts` | **MODIFIED** — Add `createWorktreeFromMain()` helper |
| `monitor/src/state/task-state-v2.ts` | **MODIFIED** — Add `claimTask()`, `promoteNextTodo()` |
| `lib/foundry-batch.sh` | **DEPRECATED** — Kept for rollback, not called |
| `lib/foundry-common.sh` | **UNCHANGED** — Worker functions remain for other bash consumers |

## Risks

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| File locking semantics differ between bash `flock` and Node.js | Medium | Use `proper-lockfile` npm package or raw `fs.open` with `O_EXCL` flag |
| Race conditions during task claiming under parallel workers | Medium | Atomic file operations + lock file pattern matching bash behavior |
| Signal handling differences between bash trap and Node.js | Low | Use `process.on('SIGTERM')` with async cleanup |
| Regression in headless mode (nohup behavior) | Low | Keep bash scripts as fallback; feature-flag TS implementation |
