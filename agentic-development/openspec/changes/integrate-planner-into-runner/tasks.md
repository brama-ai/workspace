# Tasks: Integrate u-planner into Foundry Pipeline Runner

**Change ID:** `integrate-planner-into-runner`

## Phase 1: Sync PROFILES with Planner Skill

- [ ] **1.1** Update `PROFILES` constant in `agentic-development/monitor/src/cli/foundry.ts`
  - Remove `u-auditor` from `complex` profile
  - Remove `u-architect` from `standard` and `complex` profiles (planner decides dynamically)
  - Add `complex+agent`: `["u-coder", "u-auditor", "u-validator", "u-tester", "u-summarizer"]`
  - Add `standard+docs`: `["u-coder", "u-validator", "u-tester", "u-documenter", "u-summarizer"]`
  - Add `bugfix+spec`: `["u-investigator", "u-architect", "u-coder", "u-validator", "u-tester", "u-summarizer"]`
  - Add `merge`: `["u-merger", "u-summarizer"]`
  - Add `merge+test`: `["u-merger", "u-tester", "u-summarizer"]`
  - Add `merge+deploy`: `["u-merger", "u-tester", "u-deployer", "u-summarizer"]`
  - **Verify:** `npx tsc --noEmit` passes in `agentic-development/monitor/`

- [ ] **1.2** Update help text in `showHelp()` function
  - Update `--skip-planner` description: `Skip planner agent and use profile directly (use with --profile)`
  - Update Profiles section to list all profiles from planner skill
  - Add note: `When no --profile is specified, u-planner selects the profile dynamically`
  - **Verify:** `foundry --help` shows updated profiles and descriptions

## Phase 2: Add `explicitProfile` to PipelineConfig

- [ ] **2.1** Extend `PipelineConfig` interface in `runner.ts`
  - Add `explicitProfile: boolean` field
  - **Verify:** `npx tsc --noEmit` passes

- [ ] **2.2** Set `explicitProfile` in `cmdRun` in `foundry.ts`
  - Set `explicitProfile = true` when `values.profile` is provided by the user
  - Set `explicitProfile = false` when profile is the default (`"standard"` fallback)
  - Change default profile assignment: when no `--profile` flag, set profile to `"standard"` but `explicitProfile = false`
  - Pass `explicitProfile` to `PipelineConfig`
  - **Verify:** `npx tsc --noEmit` passes

- [ ] **2.3** Move OpenSpec auto-detection behind explicit-profile guard
  - The `detectOpenSpec()` call in `cmdRun` should only run when `explicitProfile === false && config.skipPlanner === true`
  - When planner will run (no explicit profile, no skip-planner), skip auto-detection — planner handles it
  - **Verify:** `npx tsc --noEmit` passes

## Phase 3: Implement Planner Meta-Step in Runner

- [ ] **3.1** Add planner execution logic to `runPipeline()` in `runner.ts`
  - After env-check and before the main agent loop, add planner gate:
    ```
    if (!config.skipPlanner && !config.explicitProfile) → run planner
    ```
  - Execute `u-planner` using `executeAgent()` with the task message prompt
  - Use `resolveAgentRouting()` for model selection (same as other agents)
  - Use `getTimeout("u-planner")` for timeout
  - Emit `rlog("planner_start", ...)` and `rlog("planner_end", ...)`
  - Save planner result artifact to `${taskDir}/artifacts/u-planner/result.json`
  - Add planner cost to `totalCost`
  - **Verify:** `npx tsc --noEmit` passes

- [ ] **3.2** Add `pipeline-plan.json` reader function
  - Create function `readPipelinePlan(taskDir: string): PipelinePlan | null`
  - Define `PipelinePlan` interface matching the planner skill output format:
    ```typescript
    interface PipelinePlan {
      profile: string;
      reasoning: string;
      agents: string[];
      skip_openspec?: boolean;
      estimated_files?: number;
      apps_affected?: string[];
      needs_migration?: boolean;
      needs_api_change?: boolean;
      is_agent_task?: boolean;
      is_bug?: boolean;
      timeout_overrides?: Record<string, number>;
    }
    ```
  - Normalize agent names: if name doesn't start with `u-`, prepend `u-`
  - Validate: `agents` must be a non-empty array, `profile` must be a non-empty string
  - Return `null` on missing file, invalid JSON, or validation failure
  - Log warning on fallback via `rlog("planner_plan_fallback", ...)`
  - **Verify:** `npx tsc --noEmit` passes

- [ ] **3.3** Wire planner output into pipeline config
  - After planner completes and plan is read successfully:
    - Override `config.agents` with plan's normalized agent list
    - Override `config.profile` with plan's profile
    - Call `setPlannedAgents(taskDir, plan.profile, normalizedAgents)` to update state.json
    - Log the override: `console.log("   [planner] Selected profile: ${plan.profile}")`
    - Log the agents: `console.log("   [planner] Agents: ${agents.join(' -> ')}")`
  - On planner failure or missing plan:
    - Fall back to `standard` profile from `PROFILES`
    - Log: `console.log("   [planner] Fallback to standard profile")`
  - **Verify:** `npx tsc --noEmit` passes

- [ ] **3.4** Handle planner HITL (waiting_answer) scenario
  - If planner returns `hitlWaiting`, pause the pipeline (same as any other agent HITL)
  - Set task status to `waiting_answer` with `waiting_agent: "u-planner"`
  - On resume, the planner should be re-run (since it's a meta-step, not checkpointed)
  - **Verify:** `npx tsc --noEmit` passes

## Phase 4: Update Prompt and Telemetry

- [ ] **4.1** Update `buildPrompt()` for u-planner
  - The existing planner prompt is: `"Analyze this task and create a plan: ${taskMessage}"`
  - Update to include task directory: `"Analyze this task and create a plan. Write pipeline-plan.json to ${taskDir}.\n\nTask: ${taskMessage}"`
  - This ensures the planner writes to the correct task directory, not repo root
  - **Verify:** `npx tsc --noEmit` passes

- [ ] **4.2** Add planner-specific event types
  - Emit `PLANNER_START` event before planner execution
  - Emit `PLANNER_END` event after planner execution with: `{ profile, agents, duration, cost, fallback: boolean }`
  - These are distinct from `AGENT_START`/`AGENT_END` to keep planner separate from regular telemetry
  - **Verify:** `npx tsc --noEmit` passes

## Phase 5: Compilation and Smoke Test

- [ ] **5.1** Full TypeScript compilation check
  - Run `npx tsc --noEmit` in `agentic-development/monitor/`
  - Fix any type errors
  - **Verify:** zero errors

- [ ] **5.2** Verify CLI help output
  - Run `foundry --help` and confirm:
    - All planner skill profiles are listed
    - `--skip-planner` description is updated
    - Note about dynamic profile selection is present
  - **Verify:** manual inspection of help output
