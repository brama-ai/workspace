# Spec: Foundry CLI — Profile Sync and Planner Flags

**Capability:** `foundry-cli`
**Parent Change:** `integrate-planner-into-runner`

## MODIFIED Requirements

### Requirement: complex profile excludes auditor
The `complex` profile SHALL NOT include `u-auditor`. Auditor is only included by the planner via the `complex+agent` profile when the task modifies an agent app.

#### Scenario: complex profile agents
- **WHEN** `PROFILES["complex"]` is resolved
- **THEN** agents are `["u-coder", "u-validator", "u-tester", "u-summarizer"]`
- **AND** `u-auditor` is NOT included

### Requirement: standard profile excludes architect
The `standard` profile SHALL NOT include `u-architect`. The planner decides dynamically whether architect is needed.

#### Scenario: standard profile agents
- **WHEN** `PROFILES["standard"]` is resolved
- **THEN** agents are `["u-coder", "u-validator", "u-tester", "u-summarizer"]`
- **AND** `u-architect` is NOT included

### Requirement: No --profile flag triggers planner
When no `--profile` flag is passed, `cmdRun` SHALL set `explicitProfile=false` so the runner invokes the planner.

#### Scenario: No --profile flag triggers planner
- **WHEN** `foundry run "Add streaming support"` is executed (no `--profile`)
- **THEN** `profile` defaults to `"standard"` and `explicitProfile` is `false`
- **AND** planner will run in `runPipeline()`

#### Scenario: Explicit --profile skips planner
- **WHEN** `foundry run --profile standard "Add streaming support"` is executed
- **THEN** `profile` is `"standard"` and `explicitProfile` is `true`
- **AND** planner will NOT run in `runPipeline()`

#### Scenario: --skip-planner forces planner skip
- **WHEN** `foundry run --skip-planner "Add streaming support"` is executed
- **THEN** `skipPlanner` is `true` and planner will NOT run regardless of `explicitProfile`
- **AND** `standard` profile is used as default

### Requirement: OpenSpec auto-detection guard
The `detectOpenSpec()` call SHALL only run when the planner is skipped. When the planner runs, it handles OpenSpec detection itself.

#### Scenario: OpenSpec auto-detection skipped when planner runs
- **WHEN** `foundry run "Implement openspec change add-foo"` is executed (no `--profile`, no `--skip-planner`)
- **THEN** `detectOpenSpec()` is NOT called (planner handles OpenSpec detection)

#### Scenario: OpenSpec auto-detection runs when planner skipped
- **WHEN** `foundry run --skip-planner "Implement openspec change add-foo"` is executed
- **THEN** `detectOpenSpec()` IS called (planner is skipped, need auto-detection fallback)

### Requirement: Updated help text
The help text SHALL list all profiles from the planner skill and include a note about dynamic profile selection.

#### Scenario: Help text shows all profiles
- **WHEN** `foundry --help` is executed
- **THEN** `--skip-planner` description reads: `Skip planner agent and use profile directly (use with --profile)`
- **AND** Profiles section lists: quick-fix, standard, standard+docs, complex, complex+agent, bugfix, bugfix+spec, docs-only, tests-only, quality-gate, merge, merge+test, merge+deploy
- **AND** a note states: `When no --profile is specified, u-planner selects the profile dynamically`

## ADDED Requirements

### Requirement: complex+agent profile
The `complex+agent` profile SHALL include `u-auditor` for tasks that modify agent apps.

#### Scenario: complex+agent profile agents
- **WHEN** `PROFILES["complex+agent"]` is resolved
- **THEN** agents are `["u-coder", "u-auditor", "u-validator", "u-tester", "u-summarizer"]`

### Requirement: standard+docs profile
The `standard+docs` profile SHALL include `u-documenter` for features that need bilingual documentation.

#### Scenario: standard+docs profile agents
- **WHEN** `PROFILES["standard+docs"]` is resolved
- **THEN** agents are `["u-coder", "u-validator", "u-tester", "u-documenter", "u-summarizer"]`

### Requirement: bugfix+spec profile
The `bugfix+spec` profile SHALL include both `u-investigator` and `u-architect` for bugs that change spec behavior.

#### Scenario: bugfix+spec profile agents
- **WHEN** `PROFILES["bugfix+spec"]` is resolved
- **THEN** agents are `["u-investigator", "u-architect", "u-coder", "u-validator", "u-tester", "u-summarizer"]`

### Requirement: merge profile
The `merge` profile SHALL include only `u-merger` and `u-summarizer`.

#### Scenario: merge profile agents
- **WHEN** `PROFILES["merge"]` is resolved
- **THEN** agents are `["u-merger", "u-summarizer"]`

### Requirement: merge+test profile
The `merge+test` profile SHALL include `u-tester` after `u-merger`.

#### Scenario: merge+test profile agents
- **WHEN** `PROFILES["merge+test"]` is resolved
- **THEN** agents are `["u-merger", "u-tester", "u-summarizer"]`

### Requirement: merge+deploy profile
The `merge+deploy` profile SHALL include the full merge-to-deploy chain.

#### Scenario: merge+deploy profile agents
- **WHEN** `PROFILES["merge+deploy"]` is resolved
- **THEN** agents are `["u-merger", "u-tester", "u-deployer", "u-summarizer"]`

## REMOVED Requirements

### Requirement: Auditor in complex profile removed
- Removed: `u-auditor` from `PROFILES["complex"]`
- Reason: Planner skill Rule 3 — auditor only included via `complex+agent` when task modifies agent app

### Requirement: Architect in standard profile removed
- Removed: `u-architect` from `PROFILES["standard"]`
- Reason: Planner skill defines `standard` without architect; planner decides dynamically
