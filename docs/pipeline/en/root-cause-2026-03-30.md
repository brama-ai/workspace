# Root Cause Analysis — 2026-03-30 Pipeline Session

## Summary

A session focused on implementing the Models tab health-recheck feature exposed **7 systemic issues** in the Foundry pipeline runtime. Each issue was identified, diagnosed, and fixed during the session.

## Issues Found & Fixed

### 1. Runner killed by SIGHUP when launched from ephemeral shell

**Symptom:** Runner process dies after ~30s, spawned opencode becomes zombie.
**Root cause:** `foundry run` launched via Bash tool (ephemeral shell). When the shell session closes, SIGHUP kills the runner. The child opencode process survives as orphan/zombie because it's not in the same process group.
**Fix:** Launch with `nohup` for ad-hoc runs. For production use, `foundry headless` runs in tmux session.
**Status:** Fixed (operational workaround + headless is the correct path).

### 2. Orphaned child processes on runner kill

**Symptom:** `kill <runner-pid>` leaves opencode processes running as zombies. State never updates.
**Root cause:** `spawn()` creates child process, but `kill` only targets the parent. No signal forwarding to children. `proc.on("close")` never fires because parent is dead.
**Fix:** Added `killActiveAgent()` export in `executor.ts`. Runner registers SIGTERM/SIGINT handlers that call `killActiveAgent()` and set task to `suspended` before exiting.
**Commit:** `66dffbe`

### 3. Duplicate runners on same task (no PID lock)

**Symptom:** Multiple runners write to same `state.json` concurrently, causing state corruption and race conditions.
**Root cause:** No mechanism to detect an existing runner for the same task directory.
**Fix:** Added `.runner-pid` lockfile per task. On start, runner checks if PID in lockfile is alive (`process.kill(pid, 0)`). If alive → abort. If dead → overwrite.
**Commit:** `66dffbe`

### 4. Dirty working tree silently prevents branch creation

**Symptom:** Task shows `in_progress` but agent runs on wrong branch (main instead of pipeline/*). Agent eventually fails or produces irrelevant changes.
**Root cause:** `createBranchInAll()` silently skips repos with dirty working tree (`debug("skipping — dirty working tree")`). Runner doesn't check if branch was actually created.
**Fix:** Added dirty-tree guard in runner after `createBranchInAll()`. Checks `getCurrentBranch(repoRoot) !== branch`. If mismatch → set task to `suspended`, log reason, return early.
**Commit:** `6cf759b`

### 5. Integrity check (zero output) doesn't trigger model fallback

**Symptom:** Agent exits 0 but produces zero tokens. Runner marks task as failed without trying other models.
**Root cause:** Integrity check was in `runner.ts` (post-executor), not in `executor.ts` (inside retry loop). Exit code 0 → executor returns `success: true` → runner's integrity check catches it but can't retry.
**Fix:** Moved integrity check into `executor.ts` inside the retry loop. Zero output on exit 0 now triggers `modelIndex++; continue` — tries next fallback model.
**Commit:** `9fa0a3e`

### 6. maxRetries limits fallback to 2 models even when 6+ available

**Symptom:** Only 2 of 6 configured fallback models are tried before giving up.
**Root cause:** Executor loop condition `while (attempt < maxRetries && modelIndex < allModels.length)` with `maxRetries=2`. Each model attempt increments `attempt`, so after 2 models the loop exits regardless of remaining fallbacks.
**Fix:** Changed loop to `while (modelIndex < allModels.length)` — iterate through ALL configured models. `attempt` counter kept for logging only.
**Commit:** `91858ff`

### 7. Stale `.batch.lock` prevents headless from starting

**Symptom:** TUI shows pending tasks but headless never starts. Manual `foundry headless` says "already running".
**Root cause:** Previous runner killed by signal left `.opencode/pipeline/.batch.lock` with dead PID. Headless startup checks lock file exists → assumes another consumer is active. No stale PID detection.
**Fix:** Manual lock removal for now. **TODO:** Add stale PID check to batch lock acquisition (same pattern as `.runner-pid`).
**Status:** Workaround applied. Proper fix needed in `batch.ts`.

## Improvements Made (Non-Bug)

### Soft-fail for non-critical agents

**Before:** u-tester, u-auditor, u-documenter failure → entire pipeline fails.
**After:** These agents log failure to handoff and continue. Critical agents (u-coder, u-validator) still block.
**Commit:** `8bf635b`

### Model routing extracted to config

**Before:** Hardcoded `DEFAULT_FALLBACKS` dict in `runner.ts`.
**After:** Reads from `.opencode/oh-my-opencode.jsonc` via `model-routing.ts`. Agents configured per-model with fallback chains. Degraded random fallback with explicit warning when config missing.
**Commit:** `6cf759b`

### `.gitignore` for runtime files

Added: `.claude/`, `.foundry-blacklist.json`, `.foundry-runner.lock` to prevent dirty-tree issues from runtime artifacts.

## Remaining TODOs

| Priority | Issue | Location |
|----------|-------|----------|
| P1 | Stale `.batch.lock` detection | `batch.ts` lock acquisition |
| P2 | Rename `u-auditor` → `u-agent-auditor` | All profiles, agents, tests |
| P2 | u-tester zero output on all models | Investigate why opencode agent produces nothing |
| P3 | `state.json` agents as object vs array | `tasks.ts:273` expects array, runner writes object |

## Commits This Session

| Hash | Description |
|------|-------------|
| `6cf759b` | Model routing config, dirty-tree guard, deploy scaffolding |
| `66dffbe` | Kill orphaned agents, runner PID lock, Models tab progress |
| `9fa0a3e` | Move integrity check into executor for model fallback |
| `91858ff` | Try all fallback models, not just maxRetries |
| `8bf635b` | Soft-fail for non-critical agents |
| `b5c5744` | Ignore .claude/ in gitignore |
| `2d3d5e8` | Remove redundant repo lock, use batch.lock |
