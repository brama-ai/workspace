# Pipeline Handoff

- **Task**: # Delete all legacy bash scripts after TS migration is complete

Final cleanup: remove all bash scripts that have been migrated to TypeScript and update all references.

## Files to delete

From `agentic-development/lib/`:
- `foundry-batch.sh` — migrated to batch.ts (task 1)
- `foundry-run.sh` — replaced by runner.ts + executor.ts
- `foundry-common.sh` — functions migrated to task-state-v2.ts, batch.ts, actions.ts
- `foundry-retry.sh` — migrated to retry.ts (task 2)
- `foundry-cleanup.sh` — migrated to cleanup.ts (task 2)
- `foundry-stats.sh` — migrated to cmdStatus() (task 2)
- `foundry-preflight.sh` — migrated to preflight.ts (task 2)
- `foundry-setup.sh` — migrated inline (task 2)
- `foundry-telegram.sh` — port inline or delete if unused
- `foundry-e2e.sh` — keep or port (evaluate usage)
- `cost-tracker.sh` — replaced by telemetry.ts
- `env-check.sh` — replaced by preflight.ts

From `agentic-development/`:
- `foundry-legacy.sh` — legacy entrypoint, fully replaced by foundry (TS CLI)

## What to update

1. `foundry.ts` — remove ALL `runBashLib()` calls, remove `runBashLib()` function itself
2. `Makefile` — verify no targets reference deleted bash files
3. `CONVENTIONS.md` / `AGENTS.md` — update any references to bash scripts
4. `.claude/skills/foundry/SKILL.md` — update debugging docs (no more bash log paths)
5. Remove `LIB_DIR` constant from foundry.ts if no longer needed

## Constraints

- Only delete files AFTER verifying TS equivalents work
- Run `foundry run`, `foundry headless`, `foundry retry`, `foundry cleanup`, `foundry stats`, `foundry setup` — all must work without bash
- Run existing tests: `npx vitest run` must pass
- If any bash file is still referenced by a non-deleted file, do NOT delete it
- **Started**: 2026-03-28 20:18:31
- **Branch**: pipeline/delete-all-legacy-bash-scripts-after-ts-migration
- **Pipeline ID**: 20260328_201827

---

## Architect

- **Status**: pending
- **Change ID**: —
- **Apps affected**: —
- **DB changes**: —
- **API changes**: —

## Coder

- **Status**: done

### Files modified
- `agentic-development/monitor/src/cli/foundry.ts` — removed `runBashLib()` function, `LIB_DIR` constant, `SCRIPT_DIR` constant; added TS implementations of `cmdRetry()`, `cmdCleanup()`, `cmdStats()`, `cmdSetup()`; updated `monitor` case to use `REPO_ROOT`; updated `stop` case to remove `foundry-batch.sh` pkill; updated `retry/stats/cleanup/setup` cases to use TS functions; `e2e-autofix` now dynamically imports `execFileSync`
- `agentic-development/monitor/src/cli/batch.ts` — removed `LIB_DIR` constant, `execFileSync` import; replaced `foundry-run.sh` calls with `runPipeline()` from `runner.ts`; added `slugify` and `slugifyBranch` imports; added `DEFAULT_PROFILES` constant; updated `workerLoop()` to use TS pipeline runner
- `agentic-development/monitor/src/lib/actions.ts` — updated `cleanZombies()` to use inline bash instead of `foundry-common.sh`
- `agentic-development/monitor/src/lib/normalize-summary.ts` — updated `telemetryBlock()` to call `render-summary.ts` directly instead of `cost-tracker.sh`
- `agentic-development/CONVENTIONS.md` — updated code structure section to reflect TS migration
- `.claude/skills/foundry/SKILL.md` — updated debugging docs (removed bash log paths, updated process detection commands)

### Files deleted
- `agentic-development/foundry-legacy.sh` — legacy entrypoint, fully replaced by foundry TS CLI
- `agentic-development/lib/foundry-run.sh` — replaced by runner.ts + executor.ts
- `agentic-development/lib/foundry-batch.sh` — replaced by batch.ts
- `agentic-development/lib/foundry-retry.sh` — replaced by cmdRetry() in foundry.ts
- `agentic-development/lib/foundry-stats.sh` — replaced by cmdStats() in foundry.ts
- `agentic-development/lib/foundry-setup.sh` — replaced by cmdSetup() in foundry.ts
- `agentic-development/lib/cost-tracker.sh` — replaced by telemetry.ts + render-summary.ts

### Files kept (still referenced by non-deleted files)
- `agentic-development/lib/foundry-common.sh` — still referenced by `ultraworks.sh` and E2E test specs
- `agentic-development/lib/foundry-cleanup.sh` — still referenced by `foundry-common.sh` and `ultraworks.sh`
- `agentic-development/lib/foundry-preflight.sh` — still referenced by `foundry-common.sh` and E2E tests
- `agentic-development/lib/foundry-telegram.sh` — still referenced by `foundry-common.sh`
- `agentic-development/lib/env-check.sh` — still referenced by `ultraworks.sh`
- `agentic-development/lib/foundry-e2e.sh` — kept per task spec ("keep or port"), still called by foundry.ts for e2e-autofix

### Migrations created
- None

### Deviations from spec
- `foundry-common.sh`, `foundry-cleanup.sh`, `foundry-preflight.sh`, `foundry-telegram.sh`, `env-check.sh` NOT deleted because they are still referenced by `ultraworks.sh` (non-deleted file) and E2E test specs. Per constraint: "If any bash file is still referenced by a non-deleted file, do NOT delete it."
- `foundry-e2e.sh` kept per task spec instruction: "keep or port (evaluate usage)"

## Recommended follow-up tasks

### 1. Migrate ultraworks.sh bash dependencies to TypeScript
**Why:** `ultraworks.sh` still references `foundry-common.sh`, `foundry-cleanup.sh`, and `env-check.sh`. These bash scripts cannot be deleted until `ultraworks.sh` is migrated or updated.
**Files:** `agentic-development/ultraworks.sh`, `agentic-development/lib/foundry-common.sh`, `agentic-development/lib/foundry-cleanup.sh`, `agentic-development/lib/env-check.sh`

### 2. Update E2E test specs to use TS preflight instead of bash
**Why:** `tests/e2e-agents/specs/safe-start-protocol.spec.ts` and `task-stopped.spec.ts` directly call `foundry-preflight.sh` and `foundry-common.sh` bash functions. These tests need to be updated to use the TS `preflight.ts` module.
**Files:** `agentic-development/tests/e2e-agents/specs/safe-start-protocol.spec.ts`, `agentic-development/tests/e2e-agents/specs/task-stopped.spec.ts`, `agentic-development/tests/e2e-agents/utils/test-helpers.ts`

### 3. Port foundry-e2e.sh to TypeScript
**Why:** `foundry-e2e.sh` is the last bash script still called by `foundry.ts` (for `e2e-autofix` command). Porting it to TS would complete the full migration.
**Files:** `agentic-development/lib/foundry-e2e.sh`, `agentic-development/monitor/src/cli/foundry.ts`

## Validator

- **Status**: pending
- **PHPStan**: —
- **CS-check**: —
- **Files fixed**: —

## Tester

- **Status**: pending
- **Test results**: —
- **New tests written**: —

## Auditor

- **Status**: pending
- **Verdict**: —
- **Recommendations**: —

## Documenter

- **Status**: pending
- **Docs created/updated**: —

## Summarizer

- **Status**: pending
- **Summary file**: —
- **Next task recommendation**: —

---

- **Commit (u-coder)**: d30b1b8
- **Commit (u-validator)**: ac3827e
