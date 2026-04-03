# Integrate u-planner into Foundry Pipeline Runner

**Change ID:** `integrate-planner-into-runner`
**Status:** proposed
**Created:** 2026-04-03
**Author:** u-architect

## Summary

Wire the u-planner agent into the Foundry pipeline runner so it actually executes as a pre-pipeline meta-step, dynamically selecting the workflow profile and agent list instead of relying on hardcoded defaults. Synchronize the `PROFILES` constant in `foundry.ts` with the canonical profiles defined in the planner skill (`.opencode/skills/planner/SKILL.md`).

## Motivation

### Problem

1. **Planner never runs.** The `--skip-planner` flag is parsed in `foundry.ts` and passed to `PipelineConfig.skipPlanner`, but `runner.ts` never checks it. The planner agent is never invoked — every pipeline run uses the hardcoded profile directly.

2. **Auditor is hardcoded in `complex` profile.** The `PROFILES` constant in `foundry.ts` includes `u-auditor` in the `complex` profile, violating planner skill Rule 3: "Exclude auditor unless task modifies agent app (`apps/*-agent/`)". The auditor should only appear when the planner selects `complex+agent`.

3. **Profile mismatch.** The `PROFILES` constant in `foundry.ts` does not match the profiles defined in the planner skill. Missing profiles: `standard+docs`, `bugfix+spec`, `merge`, `merge+test`, `merge+deploy`, `complex+agent`. The `complex` profile incorrectly includes `u-auditor`.

4. **No dynamic workflow selection.** Without the planner, every `foundry run "task"` without `--profile` defaults to `standard`, regardless of task complexity. The planner was designed to analyze the task and choose the optimal profile, but this capability is dead code.

### Why Now

- The planner agent definition (`u-planner.md`), skill (`planner/SKILL.md`), and output format (`pipeline-plan.json`) are all fully specified and ready.
- The `PipelineConfig` interface already has `skipPlanner: boolean` — the contract exists, only the implementation is missing.
- Hardcoded auditor in `complex` causes unnecessary cost and time on non-agent tasks.
- The `AGENTS.md` documentation already describes planner-driven workflow selection as the intended behavior.

## Scope

### In Scope

- Sync `PROFILES` constant with planner skill profiles (add missing profiles, fix `complex`)
- Implement planner execution as a pre-pipeline meta-step in `runner.ts`
- Read `pipeline-plan.json` output and override planned agents in `state.json`
- Handle planner failure gracefully (fall back to `standard` profile)
- Update help text and profile list in `foundry.ts`
- Treat planner as a meta-step (not a regular pipeline agent in telemetry)

### Out of Scope

- Changing the planner agent definition or skill rules
- Adding new planner decision rules
- Modifying the `pipeline-plan.json` output format
- Changing the OpenCode agent executor or model routing
- Regression testing of all profiles (covered by separate testing task)
