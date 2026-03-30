# Foundry Safe Start Protocol

## Overview

The Safe Start Protocol ensures that Foundry tasks can start safely in a multi-task environment, preventing conflicts, data loss, and race conditions when multiple tasks run in parallel.

## Core Principles

### 1. Immutable Base Reference
Every task starts from a **pinned SHA**, not a moving branch reference:
- Default: `origin/main` or `origin/master` (latest fetched)
- Custom base allowed only with explicit `base_branch`, `base_commit`, or `base_mr` in task metadata
- Base SHA is recorded in `state.json` at task start

### 2. Dirty Workspace Protection
Foundry **never** operates on a dirty workspace:
- Checks `git status --porcelain` before any checkout/update operation
- Blocks task start if workspace has uncommitted changes
- Uses isolated worktrees for parallel execution

### 3. Task Claiming Atomicity
Tasks transition from `pending` → `in_progress` atomically using file locks:
- `fcntl` file locking prevents race conditions
- Only one worker can claim a task
- Failed claims leave task in `pending` state

### 4. Scope-Aware Execution
Tasks declare their expected scope and expansion policy:
- `initial_scope`: Files/directories the task expects to modify
- `expansion_policy`: Rules for growing beyond initial scope
- `forbidden_scope`: Paths that require manual approval

## Task States

### Standard States
- **pending**: Task ready to be claimed
- **in_progress**: Task currently executing
- **completed**: Task finished successfully
- **failed**: Task failed permanently
- **cancelled**: Task cancelled by user or system

### Stopped States
The `stopped` state indicates task was halted before or during execution. It includes detailed reasoning:

```json
{
  "status": "stopped",
  "stop_reason": "safe_start_criteria_unmet",
  "stop_details": {
    "workspace_state": "dirty",
    "workspace_type": "default_branch",
    "detected_changes": ["tracked_modified", "untracked"],
    "critical_paths_touched": [".gitlab-ci.yml", "package-lock.json"]
  },
  "stopped_at": "2026-03-26T10:30:00Z",
  "stopped_by": "system",
  "message": "Task did not start because safe start criteria were not met."
}
```

#### Stop Reasons

**Safe Start Failures:**
- `safe_start_criteria_unmet` - General preflight failure
- `dirty_default_workspace` - Main/master branch has uncommitted changes
- `dirty_active_task_workspace` - Task workspace is dirty
- `base_resolution_failed` - Cannot resolve base reference
- `exclusive_scope_conflict` - Another task holds exclusive lock on required scope
- `task_already_in_progress` - Task is already running elsewhere
- `recovery_required` - Previous execution left inconsistent state
- `unsafe_unregistered_activity_detected` - Untracked changes in critical paths

**Manual Stops:**
- `stopped_by_user` - User manually stopped the task
- `stopped_by_system` - System stop (e.g., during shutdown)

**Resource Constraints:**
- `insufficient_resources` - Not enough CPU/memory/disk
- `dependency_unavailable` - Required service or resource not available

### Suspended vs Stopped

- **suspended**: Task paused mid-execution, can be resumed from checkpoint
- **stopped**: Task never started or was permanently halted

## Preflight Checks

Before transitioning a task to `in_progress`, Foundry performs these checks:

### 1. Task Validity
```bash
✓ task.md exists and is readable
✓ state.json exists or can be created
✓ task_id is unique
✓ task is not already claimed by another worker
✓ no stale in_progress state from crashed worker
```

### 2. Base Reference Validation
```bash
✓ git fetch succeeds
✓ requested base reference exists (origin/main, custom branch, commit, etc.)
✓ base SHA can be resolved
✓ if non-default base: explicit allow flag present in task metadata
```

### 3. Workspace Safety
```bash
✓ root workspace is clean (no uncommitted changes)
✓ sub-project workspaces are clean (brama-core/, brama-website/, etc.)
✓ no untracked files in critical paths
✓ no dirty state in default branch checkout
✓ if using worktree: worktree can be created
```

### 4. Sub-Project Branch Readiness
```bash
✓ all sub-projects with clean working trees can create pipeline branch
✓ pipeline/<task-slug> branch created in root + clean sub-projects
✓ sub-projects with dirty state are skipped (logged as warning)
```

### 5. Concurrency Safety
```bash
✓ no exclusive lock on required scope by another task
✓ initial scope defined or can be inferred
✓ execution mode determined (isolated, guarded, blocked)
✓ no conflicting file claims
```

### 6. Policy Readiness
```bash
✓ risk_class defined (low, medium, high, critical)
✓ expansion_policy defined (none, bounded, ask, auto)
✓ forbidden_scope defined
✓ finalize_policy known
```

## Preflight Failure Handling

When preflight fails:

1. **Task NOT transitioned to in_progress**
2. **Status set to `stopped`**
3. **Detailed stop_reason and stop_details recorded**
4. **Event logged to events.jsonl**
5. **Handoff.md updated with recovery instructions**

Example failure event:
```jsonl
{
  "timestamp": "2026-03-26T10:30:00Z",
  "type": "preflight_failed",
  "reason": "dirty_default_workspace",
  "details": {
    "workspace": "/workspaces/brama",
    "uncommitted_files": ["package-lock.json", "src/test.php"],
    "critical_paths": true
  }
}
```

## state.json Schema

### Extended Fields for Safe Start

```json
{
  "task_id": "my-task--foundry",
  "workflow": "foundry",
  "status": "stopped",
  "attempt": 1,
  "worker_id": null,

  // Timestamps
  "created_at": "2026-03-26T10:00:00Z",
  "started_at": null,
  "claimed_at": null,
  "stopped_at": "2026-03-26T10:30:00Z",
  "updated_at": "2026-03-26T10:30:00Z",
  "finished_at": null,

  // Base reference
  "requested_base": "default",
  "resolved_base_ref": "origin/main",
  "resolved_base_sha": "abc123def456",
  "non_default_base": false,

  // Execution control
  "execution_mode": "isolated",
  "risk_class": "medium",

  // Scope management
  "initial_scope": ["services/payments/**"],
  "expanded_scope": [],
  "forbidden_scope": ["db/migrations/**", ".gitlab-ci.yml", "package-lock.json"],
  "expansion_policy": "bounded",

  // Stop details (if status=stopped)
  "stop_reason": "safe_start_criteria_unmet",
  "stop_details": {
    "workspace_state": "dirty",
    "workspace_type": "default_branch",
    "detected_changes": ["tracked_modified"],
    "critical_paths_touched": [".gitlab-ci.yml"]
  },
  "stopped_by": "system",

  // Task context
  "task_file": "/workspaces/brama/tasks/my-task--foundry/task.md",
  "branch": null,
  "current_step": null,
  "resume_from": null,

  // Agent execution (if started)
  "agents": []
}
```

## Task Metadata (task.md frontmatter)

Tasks can specify safe start requirements in YAML frontmatter:

```yaml
---
task_id: payments-refactor--foundry
base: default
base_branch: feature/payments-v2  # if non-default
risk_class: medium
initial_scope:
  - services/payments/**
  - tests/unit/payments/**
allowed_expansion:
  - packages/payment-sdk/**
  - docs/payments/**
forbidden_scope:
  - db/migrations/**
  - .gitlab-ci.yml
  - package-lock.json
allow_non_default_base: false
expansion_policy: bounded
needs_human_if_scope_expands_to_forbidden: true
---

# Task: Refactor Payment Service

Description here...
```

## Critical Paths

These paths require special handling (exclusive locks or manual approval):

- **Dependency manifests**: `package.json`, `composer.json`, `Gemfile`, `requirements.txt`, lockfiles
- **CI/CD configuration**: `.gitlab-ci.yml`, `.github/workflows/**`, `Jenkinsfile`
- **Database migrations**: `db/migrations/**`, `database/migrations/**`
- **API schemas**: `openapi.yaml`, `schema.graphql`, `proto/**`
- **Build configuration**: `Dockerfile`, `docker-compose.yml`, `webpack.config.js`
- **Infrastructure**: `infra/**`, `terraform/**`, `k8s/**`
- **Global config**: `config/app.php`, `.env.example`, feature flags

## Execution Modes

### Isolated Mode
- No conflicts detected
- Task runs in dedicated worktree
- Auto-expand allowed within expansion_policy
- Standard finalization

### Guarded Mode
- Advisory overlap detected with other tasks
- Expansion to critical zones blocked
- Frequent sync checks required
- Stricter finalization validation

### Blocked Mode
- Exclusive conflict detected
- Task cannot start
- Status: `stopped` with reason `exclusive_scope_conflict`

## Prepare Stage (Dynamic Exclusive Operations)

The `prepare` stage provides exclusive access to critical shared resources. Unlike other checks, prepare is **dynamic** - it's triggered mid-execution when an agent determines it needs to modify critical paths.

### When Prepare is Triggered

Prepare stage is activated automatically when an agent:
- Creates or modifies database migrations
- Changes root dependency files (package.json, composer.json, lockfiles)
- Modifies CI/CD configuration
- Updates OpenAPI/GraphQL/Protobuf schemas
- Changes infrastructure configuration

**Key insight**: We don't know at task start if migrations will be needed - they might be discovered during review, testing, or coder phases.

### Prepare Stage Behavior

1. **Agent signals need for prepare** (from its worktree):
   ```python
   # In agent code (running in .pipeline-worktrees/worker-1/):
   context.request_prepare(
       scope=["db/migrations/**"],
       reason="Creating user_profiles migration",
       estimated_duration=300  # seconds
   )
   ```

2. **Foundry transitions task**: `in_progress` → `preparing`

3. **Exclusive lock acquired on MAIN repo**:
   - Only ONE task can be in `preparing` state at a time
   - All other workers pause (even if parallel workers enabled)
   - Lock covers specified scope (e.g., db/migrations/**)
   - **Important**: Lock is on the shared critical path, NOT on the worktree

4. **Agent performs exclusive operations in MAIN repo**:
   - Temporarily switches to main repo (not worktree) for critical operations
   - Creates migration file in main repo: `db/migrations/2026_03_26_create_user_profiles.php`
   - Migration timestamp ensures sequential ordering
   - Other critical files (lockfiles, schemas) also modified in main repo

5. **Changes synced back to worktree**:
   - Agent pulls migration file from main repo into worktree
   - Continues working in worktree with migration included

6. **Lock released**: Task returns to `in_progress`

7. **Other workers resume** and can request prepare if needed

### Worktree vs Main Repo for Critical Operations

| Operation | Location | Why |
|-----------|----------|-----|
| Feature code | Worktree (`task-branch`) | Isolated per task |
| Tests, docs | Worktree | Isolated per task |
| **Migrations** | **Main repo** | **Must be sequential, unique timestamps** |
| **Lockfiles** | **Main repo** | **Avoid dependency conflicts** |
| **CI config** | **Main repo** | **Single source of truth** |
| **API schemas** | **Main repo** | **Contract consistency** |

### Why Not Create Migrations in Worktree?

**Problem**: If two tasks create migrations in parallel worktrees:
- Task A: `2026_03_26_100500_add_users.php` (in worktree-1)
- Task B: `2026_03_26_100501_add_profiles.php` (in worktree-2)
- Both merge → Migration order undefined, potentially breaks

**Solution**: Exclusive lock ensures migrations created sequentially in main repo:
- Task A holds lock → Creates in main → Releases
- Task B waits → Gets lock → Creates in main with later timestamp → Success

### State Transitions with Prepare

```
pending → in_progress → preparing → in_progress → completed
                          ↑
                          |
                  (exclusive lock held)
```

### Prepare State Schema

When a task enters prepare stage, `state.json` is updated:

```json
{
  "status": "preparing",
  "prepare_start": "2026-03-26T10:30:00Z",
  "prepare_scope": ["db/migrations/**"],
  "prepare_reason": "Creating user_profiles migration",
  "prepare_lock_id": "prepare-lock-abc123",
  "prepare_estimated_duration": 300,
  "exclusive_lock_held": true
}
```

### Multi-Agent Flow Example

**Scenario**: Task starts without knowing it needs migrations:

1. **Coder agent**: Implements user profiles feature
2. **Validator agent**: PHPStan passes, but notes missing migration
3. **Coder agent (retry)**: Determines migration needed
   - Signals: `request_prepare(scope=["db/migrations/**"])`
   - Foundry: Transitions to `preparing`
   - Coder: Creates migration file safely
   - Foundry: Returns to `in_progress`
4. **Tester agent**: Runs tests with new migration
5. **Summarizer**: Completes

### Prepare vs Initial Scope

| Aspect | Initial Scope | Prepare Stage |
|--------|---------------|---------------|
| When defined | Task creation | Mid-execution (dynamic) |
| Lock type | Advisory | Exclusive |
| Affects workers | Can run in parallel | Blocks ALL workers |
| Duration | Entire task | Short burst (minutes) |
| Example | `services/payments/**` | `db/migrations/**` |

### Handling Prepare Conflicts

If a task requests prepare while another task holds the lock:

1. **Current task** (in `preparing`) continues
2. **Requesting task** enters `waiting_for_prepare` sub-state
3. **Events logged** to both tasks' `events.jsonl`
4. **Timeout**: If prepare takes > estimated_duration × 2, lock is force-released

### Critical Paths Requiring Prepare

The following paths automatically trigger prepare if modified:

- `db/migrations/**`
- `database/migrations/**`
- `package.json`, `package-lock.json`
- `composer.json`, `composer.lock`
- `.gitlab-ci.yml`, `.github/workflows/**`
- `openapi.yaml`, `schema.graphql`, `proto/**`
- `Dockerfile`, `docker-compose.yml`
- `infra/**`, `terraform/**`, `k8s/**`

### Configuration

Enable/disable dynamic prepare:

```bash
# In .foundry-config.json
{
  "prepare_enabled": true,
  "prepare_max_duration": 600,  # 10 minutes
  "prepare_timeout_multiplier": 2
}
```

### Monitoring Prepare State

```bash
# Check if any task is in prepare
./agentic-development/foundry status | grep preparing

# View prepare queue
./agentic-development/foundry status --verbose

# Force-release stuck prepare lock (use with caution!)
./agentic-development/foundry unlock-prepare --task <task-slug>
```

### Example: Coder Discovers Migration Need

```python
# In u-coder agent logic:

def create_user_profiles_feature(context):
    # Implement feature code
    context.write_file("src/UserProfile.php", content)

    # Realize we need a migration
    if context.requires_database_changes():
        # Request exclusive access
        with context.prepare_stage(
            scope=["db/migrations/**"],
            reason="Creating user_profiles table migration"
        ):
            # Now we have exclusive lock
            migration_file = generate_migration("create_user_profiles_table")
            context.write_file(f"db/migrations/{migration_file}", migration_content)

        # Lock automatically released, task continues
```

## Recovery from Stopped State

### Manual Resume
```bash
# Fix the issue (commit changes, resolve conflicts, etc.)
./agentic-development/foundry resume <task-slug>
```

### Automatic Retry
Foundry can be configured to auto-retry stopped tasks after a delay:
```bash
FOUNDRY_AUTO_RETRY_STOPPED=true
FOUNDRY_RETRY_STOPPED_DELAY=300  # 5 minutes
```

## Best Practices

### For Task Authors
1. **Declare scope explicitly** in task.md frontmatter
2. **Use default base** unless there's a specific reason not to
3. **Mark critical operations** with `requires_prepare: true`
4. **Specify risk_class** accurately (low, medium, high, critical)

### For Operators
1. **Keep main/master branch clean** - no uncommitted changes
2. **Use worktrees for parallel execution** - never share workspace
3. **Monitor stopped tasks** - investigate and resolve root causes
4. **Set up auto-cleanup** - archive old stopped tasks

### For Foundry Developers
1. **Test preflight checks thoroughly** - use E2E tests
2. **Log all stop reasons** - detailed diagnostics in events.jsonl
3. **Make stop_details actionable** - include recovery instructions
4. **Validate state transitions** - ensure atomicity

## Troubleshooting

### Task Stopped: dirty_default_workspace
```bash
# Check what's dirty
git status

# Commit or stash changes
git stash save "WIP: manual changes"

# Resume task
./agentic-development/foundry resume <task-slug>
```

### Task Stopped: exclusive_scope_conflict
```bash
# Check what tasks are running
./agentic-development/foundry status

# Wait for conflicting task to finish, or stop it
./agentic-development/foundry stop <conflicting-task-slug>
```

### Task Stopped: base_resolution_failed
```bash
# Fetch latest refs
git fetch origin

# If custom base: verify branch exists
git branch -r | grep <base_branch>

# Update task metadata if needed
vim tasks/<task-slug>--foundry/task.md
```

## Implementation Notes

### Worktree Management
- Worktrees created at `.pipeline-worktrees/worker-N/`
- One worktree per worker
- Worktrees cleaned up on worker shutdown
- `git worktree prune` runs periodically

### File Locking
- Uses Python `fcntl.flock()` for atomic claims
- Lock files: `tasks/<slug>--foundry/.claim.lock`
- Locks released automatically on process exit
- Stale locks cleaned up after timeout

### Scope Detection
- Initial scope inferred from task description (AI-powered)
- Expansion tracked in state.json `expanded_scope` array
- Forbidden scope enforced at filesystem level
- Scope conflicts detected via advisory locks

## References

- [Foundry Main Documentation](./foundry.md)
- [Foundry E2E Tests](../../tests/e2e-agents/README.md)
- [Git Worktree Documentation](https://git-scm.com/docs/git-worktree)
- [Brainstorming Notes](../../../improvment-durability.md)
