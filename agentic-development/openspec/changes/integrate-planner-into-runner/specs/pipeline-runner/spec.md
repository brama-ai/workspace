# Spec: Pipeline Runner — Planner Integration

**Capability:** `pipeline-runner`
**Parent Change:** `integrate-planner-into-runner`

## ADDED Requirements

### Requirement: Planner meta-step execution
When no explicit profile is passed and `skipPlanner` is false, the runner SHALL execute u-planner as a pre-pipeline meta-step before the main agent loop. The planner writes `pipeline-plan.json` to the task directory, and the runner reads it to determine the profile and agent list.

#### Scenario: Planner runs as meta-step when no explicit profile
- **WHEN** `runPipeline()` is called with `skipPlanner=false` and `explicitProfile=false`
- **THEN** u-planner executes before the main agent loop
- **AND** `pipeline-plan.json` is read from the task directory
- **AND** the planned agents in `state.json` are overridden with planner output
- **AND** the main agent loop uses planner-selected agents

#### Scenario: Planner output overrides pipeline config
- **WHEN** planner writes `pipeline-plan.json` with `{ "profile": "complex+agent", "agents": ["coder", "auditor", "validator", "tester", "summarizer"] }`
- **THEN** `config.agents` becomes `["u-coder", "u-auditor", "u-validator", "u-tester", "u-summarizer"]`
- **AND** `config.profile` becomes `"complex+agent"`
- **AND** `setPlannedAgents(taskDir, "complex+agent", [...])` is called

#### Scenario: Agent name normalization
- **WHEN** planner writes agents as `["coder", "validator", "tester", "summarizer"]` (no `u-` prefix)
- **THEN** agents are normalized to `["u-coder", "u-validator", "u-tester", "u-summarizer"]`

### Requirement: Planner failure fallback
When the planner fails or produces invalid output, the runner SHALL fall back to the `standard` profile and continue the pipeline without failing.

#### Scenario: Planner failure falls back to standard
- **WHEN** planner exits with non-zero code or `pipeline-plan.json` is missing
- **THEN** pipeline continues with `standard` profile from `PROFILES` constant
- **AND** a warning is logged via `rlog("planner_plan_fallback", ...)`
- **AND** pipeline does NOT fail — it proceeds with fallback agents

#### Scenario: Planner writes invalid JSON
- **WHEN** planner writes `pipeline-plan.json` with invalid JSON content
- **THEN** `readPipelinePlan()` returns `null`
- **AND** pipeline falls back to `standard` profile

### Requirement: Planner HITL support
When the planner returns with `hitlWaiting`, the pipeline SHALL pause and set the task to waiting state.

#### Scenario: Planner HITL waiting
- **WHEN** planner returns with `hitlWaiting=true`
- **THEN** task status is set to `waiting_answer` with `waiting_agent: "u-planner"`
- **AND** pipeline pauses (does not proceed to main agent loop)

### Requirement: Planner is a meta-step in telemetry
The planner SHALL NOT appear as a regular pipeline agent in telemetry. It is a meta-step that runs before the main agent loop.

#### Scenario: Planner excluded from regular telemetry
- **WHEN** planner executes successfully
- **THEN** planner does NOT appear in `state.json.agents` telemetry map
- **AND** planner does NOT appear in `state.json.planned_agents`
- **AND** planner cost is added to pipeline `totalCost`
- **AND** planner result artifact is saved to `${taskDir}/artifacts/u-planner/result.json`

### Requirement: PipelineConfig explicitProfile field
The `PipelineConfig` interface SHALL include an `explicitProfile: boolean` field to distinguish user-specified profiles from defaults.

#### Scenario: explicitProfile field in PipelineConfig
- **WHEN** a new pipeline run is configured
- **THEN** `explicitProfile: boolean` field indicates whether the user passed `--profile`
- **AND** `explicitProfile=true` means planner is skipped (user chose profile)
- **AND** `explicitProfile=false` means planner may run (default behavior)

### Requirement: PipelinePlan interface
The runner SHALL define a `PipelinePlan` interface matching the planner skill output format for type-safe parsing of `pipeline-plan.json`.

#### Scenario: PipelinePlan type definition
- **WHEN** `readPipelinePlan()` parses the file
- **THEN** it validates against `PipelinePlan` interface with required fields `profile: string` (non-empty) and `agents: string[]` (non-empty array)
- **AND** optional fields: `reasoning`, `skip_openspec`, `estimated_files`, `apps_affected`, `timeout_overrides`

## MODIFIED Requirements

### Requirement: Pipeline start logging includes planner info
When the planner runs, the console output SHALL include planner-specific log lines showing the selected profile and agents.

#### Scenario: Planner selection logged to console
- **WHEN** pipeline starts with planner enabled and planner completes successfully
- **THEN** output includes `[planner] Selected profile: <profile>` after planner completes
- **AND** output includes `[planner] Agents: <agent1> -> <agent2> -> ...`
