# Design: Integrate u-planner into Foundry Pipeline Runner

## Problem

The Foundry pipeline runner has a `skipPlanner` config field that is never checked. Every pipeline run uses a hardcoded profile, bypassing the planner agent entirely. Additionally, the `PROFILES` constant diverges from the canonical profiles in the planner skill, causing incorrect agent selection (e.g., auditor hardcoded in `complex`).

## Goals

- Make the planner the default first step when no explicit `--profile` is passed
- Synchronize `PROFILES` with the planner skill as the single source of truth
- Keep backward compatibility: `--profile X` still works without planner
- Handle planner failure gracefully with fallback to `standard`
- Treat planner as a meta-step, not a regular pipeline agent

## Non-Goals

- Changing planner decision rules or output format
- Adding new profiles beyond what the planner skill defines
- Modifying the agent executor or model routing logic

## Approach

### 1. Profile Synchronization

Replace the `PROFILES` constant in `foundry.ts` with the exact profiles from `.opencode/skills/planner/SKILL.md`:

| Profile | Current (foundry.ts) | Corrected (from skill) |
|---------|---------------------|------------------------|
| `quick-fix` | coder, validator, summarizer | coder, validator, summarizer (unchanged) |
| `standard` | architect, coder, validator, tester, summarizer | coder, validator, tester, summarizer |
| `complex` | architect, coder, **auditor**, validator, tester, summarizer | coder, validator, tester, summarizer (NO auditor) |
| `complex+agent` | (missing) | coder, **auditor**, validator, tester, summarizer |
| `standard+docs` | (missing) | coder, validator, tester, documenter, summarizer |
| `bugfix` | investigator, coder, validator, tester, summarizer | investigator, coder, validator, tester, summarizer (unchanged) |
| `bugfix+spec` | (missing) | investigator, architect, coder, validator, tester, summarizer |
| `docs-only` | documenter, summarizer | documenter, summarizer (unchanged) |
| `tests-only` | coder, tester, summarizer | coder, tester, summarizer (unchanged) |
| `quality-gate` | coder, validator, summarizer | coder, validator, summarizer (unchanged) |
| `merge` | (missing) | merger, summarizer |
| `merge+test` | (missing) | merger, tester, summarizer |
| `merge+deploy` | (missing) | merger, tester, deployer, summarizer |
| `openspec` | coder, validator, tester, summarizer | coder, validator, tester, summarizer (unchanged) |
| `simple` | coder, summarizer | coder, summarizer (unchanged) |

**Key change:** `standard` and `complex` profiles lose `u-architect`. The planner skill defines these profiles without architect because the planner itself decides whether architect is needed (via `bugfix+spec` or by prepending architect to the agent list). When the user explicitly passes `--profile standard`, they get the skill-defined list. The planner may still prepend architect if it determines the task needs one.

**Decision:** Remove `u-architect` from `standard` and `complex` hardcoded profiles to match the planner skill exactly. The planner can dynamically add architect when needed. For backward compatibility, if a user explicitly passes `--profile standard` (skipping planner), they get the skill-defined profile without architect. This is intentional — explicit profile selection means the user knows what they want.

### 2. Planner Execution as Meta-Step

The planner runs as a **pre-pipeline meta-step** — before the main agent loop, outside the normal telemetry tracking.

**Trigger conditions:**
- `skipPlanner === false` (default)
- AND no explicit `--profile` was passed by the user

When both conditions are met, the runner:
1. Executes `u-planner` with the task message
2. Waits for completion
3. Reads `pipeline-plan.json` from the task directory
4. Extracts `profile` and `agents` fields
5. Overrides `config.agents` and `config.profile` with planner output
6. Updates `state.json` planned_agents via `setPlannedAgents()`
7. Proceeds with the main agent loop using planner-selected agents

**Signaling explicit profile to runner:** The `cmdRun` function in `foundry.ts` currently defaults `profile` to `"standard"` when no `--profile` flag is passed. This makes it impossible for the runner to distinguish "user chose standard" from "no profile specified". 

**Solution:** Add a new field `explicitProfile: boolean` to `PipelineConfig`. Set it to `true` only when the user passes `--profile`. The runner checks: `if (!config.skipPlanner && !config.explicitProfile)` → run planner.

### 3. Pipeline-plan.json Reading

After planner execution, the runner reads `${taskDir}/pipeline-plan.json`. The expected schema (from planner skill):

```json
{
  "profile": "standard",
  "reasoning": "...",
  "agents": ["coder", "validator", "tester", "summarizer"],
  "skip_openspec": true,
  "estimated_files": 8,
  "apps_affected": ["core"],
  "needs_migration": false,
  "needs_api_change": false,
  "is_agent_task": false,
  "is_bug": false,
  "bug_severity": null,
  "timeout_overrides": {},
  "model_overrides": {}
}
```

**Agent name normalization:** The planner skill uses short names (`coder`, `validator`) while the runner uses prefixed names (`u-coder`, `u-validator`). The reader must normalize: if an agent name doesn't start with `u-`, prepend `u-`.

**Fallback:** If `pipeline-plan.json` is missing, unreadable, or has invalid JSON after planner execution, fall back to `standard` profile and log a warning.

### 4. Planner Telemetry

The planner is a **meta-step**, not a regular pipeline agent:
- It does NOT appear in `state.json.agents` telemetry
- It does NOT appear in `state.json.planned_agents`
- Its execution is logged via `rlog("planner_start", ...)` and `rlog("planner_end", ...)`
- Its cost is added to `totalCost` but attributed as `planner_cost` in the pipeline result
- An event `PLANNER_START` / `PLANNER_END` is emitted for observability

However, for debugging purposes, the planner's result artifact is still saved to `${taskDir}/artifacts/u-planner/result.json`.

### 5. Skip-Planner Semantics

| Scenario | Planner runs? | Profile source |
|----------|--------------|----------------|
| `foundry run "task"` | Yes | planner output |
| `foundry run --profile standard "task"` | No | explicit `standard` |
| `foundry run --skip-planner "task"` | No | default `standard` |
| `foundry run --skip-planner --profile complex "task"` | No | explicit `complex` |

The `--skip-planner` flag is a hard override. When set, the planner never runs regardless of other flags. The `--profile` flag implies skip-planner (explicit profile = no need for planner).

### 6. OpenSpec Auto-Detection Interaction

The existing `detectOpenSpec()` logic in `cmdRun` switches profile from `standard` to `openspec` when an existing OpenSpec change is detected. This logic should only apply when the planner is skipped (explicit profile or `--skip-planner`). When the planner runs, it handles OpenSpec detection itself via its own analysis steps.

## Alternatives Considered

### A. Run planner as the first agent in the regular agent list

**Rejected.** This would make the planner appear in telemetry, planned_agents, and handoff as a regular agent. It would also require the planner to modify the agent list mid-pipeline, which the current runner loop doesn't support (it iterates a fixed `agents` array).

### B. Add planner logic directly to `cmdRun` in `foundry.ts`

**Rejected.** The planner needs to execute as an OpenCode agent (with model routing, fallback, timeout handling). This logic lives in `runner.ts` via `executeAgent()`. Moving it to `foundry.ts` would duplicate the agent execution infrastructure.

### C. Keep `u-architect` in `standard` and `complex` profiles

**Rejected.** The planner skill is the source of truth for profiles. The skill defines `standard` without architect because the planner dynamically decides whether architect is needed. Keeping architect hardcoded defeats the purpose of dynamic workflow selection.

## Component Interactions

```
foundry.ts (CLI)
  ├── Parses --profile, --skip-planner flags
  ├── Sets explicitProfile: boolean in PipelineConfig
  └── Calls runPipeline(config)

runner.ts (Pipeline Runner)
  ├── Checks: !skipPlanner && !explicitProfile
  │   ├── YES → Execute u-planner meta-step
  │   │   ├── executeAgent(plannerConfig, plannerPrompt, ...)
  │   │   ├── Read ${taskDir}/pipeline-plan.json
  │   │   ├── Normalize agent names (add u- prefix)
  │   │   ├── Override config.agents and config.profile
  │   │   └── Update state.json planned_agents
  │   └── NO → Use config.agents as-is
  └── Main agent loop (unchanged)
```

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| Planner produces invalid plan | Low | Medium | Fallback to `standard` profile |
| Planner adds unknown agent name | Low | High | Validate agent names against known set |
| Planner timeout delays pipeline start | Medium | Low | Use standard agent timeout; log warning |
| Breaking existing `--profile` workflows | Low | High | Explicit profile bypasses planner entirely |
| OpenSpec auto-detect conflicts with planner | Low | Low | Only run auto-detect when planner is skipped |
