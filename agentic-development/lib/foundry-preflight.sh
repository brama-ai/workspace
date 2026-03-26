#!/usr/bin/env bash

# Foundry Safe Start Protocol - Preflight Checks
# Validates that a task can safely start before transitioning to in_progress

: "${REPO_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

# shellcheck source=/dev/null
source "$REPO_ROOT/agentic-development/lib/foundry-common.sh"

# ── Stop Reason Constants ────────────────────────────────────────────

# Safe start failures
readonly STOP_REASON_SAFE_START_UNMET="safe_start_criteria_unmet"
readonly STOP_REASON_DIRTY_DEFAULT_WORKSPACE="dirty_default_workspace"
readonly STOP_REASON_DIRTY_TASK_WORKSPACE="dirty_active_task_workspace"
readonly STOP_REASON_BASE_RESOLUTION_FAILED="base_resolution_failed"
readonly STOP_REASON_EXCLUSIVE_CONFLICT="exclusive_scope_conflict"
readonly STOP_REASON_ALREADY_IN_PROGRESS="task_already_in_progress"
readonly STOP_REASON_RECOVERY_REQUIRED="recovery_required"
readonly STOP_REASON_UNSAFE_ACTIVITY="unsafe_unregistered_activity_detected"

# Manual stops
readonly STOP_REASON_USER="stopped_by_user"
readonly STOP_REASON_SYSTEM="stopped_by_system"

# Resource constraints
readonly STOP_REASON_INSUFFICIENT_RESOURCES="insufficient_resources"
readonly STOP_REASON_DEPENDENCY_UNAVAILABLE="dependency_unavailable"

# ── Critical Paths (require exclusive access) ────────────────────────

readonly CRITICAL_PATHS=(
  "package.json"
  "package-lock.json"
  "composer.json"
  "composer.lock"
  "Gemfile"
  "Gemfile.lock"
  "requirements.txt"
  "Pipfile"
  "Pipfile.lock"
  ".gitlab-ci.yml"
  ".github/workflows"
  "Jenkinsfile"
  "db/migrations"
  "database/migrations"
  "openapi.yaml"
  "schema.graphql"
  "proto"
  "Dockerfile"
  "docker-compose.yml"
  "webpack.config.js"
  "infra"
  "terraform"
  "k8s"
  ".env.example"
)

# Check if a path matches any critical path pattern
is_critical_path() {
  local path="$1"
  for pattern in "${CRITICAL_PATHS[@]}"; do
    if [[ "$path" == *"$pattern"* ]]; then
      return 0
    fi
  done
  return 1
}

# ── Workspace Safety Checks ──────────────────────────────────────────

# Check if workspace is clean (no uncommitted changes)
# Returns 0 if clean, 1 if dirty
# Outputs: dirty_files (JSON array), has_critical (bool)
check_workspace_clean() {
  local workspace_dir="${1:-$REPO_ROOT}"
  python3 - "$workspace_dir" <<'PYEOF'
import json
import subprocess
import sys
from pathlib import Path

workspace = Path(sys.argv[1])
critical_patterns = [
    "package.json", "package-lock.json", "composer.json", "composer.lock",
    ".gitlab-ci.yml", ".github/workflows", "Jenkinsfile",
    "db/migrations", "database/migrations",
    "openapi.yaml", "schema.graphql", "proto/",
    "Dockerfile", "docker-compose.yml",
    "infra/", "terraform/", "k8s/"
]

try:
    result = subprocess.run(
        ["git", "-C", str(workspace), "status", "--porcelain"],
        capture_output=True, text=True, check=True
    )
    dirty_lines = [line for line in result.stdout.strip().split("\n") if line]

    if not dirty_lines:
        print(json.dumps({"clean": True, "dirty_files": [], "has_critical": False}))
        sys.exit(0)

    dirty_files = []
    has_critical = False

    for line in dirty_lines:
        # Format: "XY filename"
        if len(line) < 4:
            continue
        status = line[:2]
        filepath = line[3:]

        change_type = []
        if status[0] in "MARC":
            change_type.append("staged")
        if status[1] in "MD":
            change_type.append("tracked_modified")
        if status == "??":
            change_type.append("untracked")

        is_critical = any(pattern in filepath for pattern in critical_patterns)
        if is_critical:
            has_critical = True

        dirty_files.append({
            "path": filepath,
            "status": status,
            "change_type": change_type,
            "is_critical": is_critical
        })

    print(json.dumps({
        "clean": False,
        "dirty_files": dirty_files,
        "has_critical": has_critical
    }))
    sys.exit(1)  # Dirty

except subprocess.CalledProcessError:
    print(json.dumps({"clean": False, "error": "git_command_failed"}))
    sys.exit(1)
PYEOF
}

# Get current branch name
get_current_branch() {
  local workspace_dir="${1:-$REPO_ROOT}"
  git -C "$workspace_dir" branch --show-current 2>/dev/null || echo ""
}

# Get main branch name (main or master)
get_main_branch() {
  local workspace_dir="${1:-$REPO_ROOT}"
  git -C "$workspace_dir" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null \
    | sed 's@refs/remotes/origin/@@' || echo "main"
}

# Check if current branch is main/master
is_on_main_branch() {
  local workspace_dir="${1:-$REPO_ROOT}"
  local current_branch
  local main_branch
  current_branch=$(get_current_branch "$workspace_dir")
  main_branch=$(get_main_branch "$workspace_dir")
  [[ "$current_branch" == "$main_branch" || "$current_branch" == "main" || "$current_branch" == "master" ]]
}

# ── Base Reference Resolution ────────────────────────────────────────

# Resolve base reference to SHA
# Input: base_ref (e.g., "origin/main", "abc123", "feature/branch")
# Output: SHA or empty string
resolve_base_sha() {
  local base_ref="$1"
  local workspace_dir="${2:-$REPO_ROOT}"

  # Try to resolve as commit-ish
  git -C "$workspace_dir" rev-parse --verify "${base_ref}^{commit}" 2>/dev/null || echo ""
}

# Fetch latest refs from origin
fetch_origin() {
  local workspace_dir="${1:-$REPO_ROOT}"
  git -C "$workspace_dir" fetch origin 2>&1 || return 1
}

# ── Preflight Check Functions ────────────────────────────────────────

# 1. Task Validity Check
preflight_check_task_validity() {
  local task_dir="$1"
  local issues=()

  # task.md exists
  if [[ ! -f "$task_dir/task.md" ]]; then
    issues+=("task.md does not exist")
  fi

  # task_dir is actually a directory
  if [[ ! -d "$task_dir" ]]; then
    issues+=("task directory does not exist or is not a directory")
  fi

  # task_dir follows naming convention
  if [[ ! "$task_dir" =~ --foundry ]]; then
    issues+=("task directory does not follow --foundry naming convention")
  fi

  if [[ ${#issues[@]} -gt 0 ]]; then
    printf '%s\n' "${issues[@]}"
    return 1
  fi
  return 0
}

# 2. Base Reference Validation
preflight_check_base_reference() {
  local task_dir="$1"
  local requested_base="${2:-default}"

  # Fetch latest refs
  if ! fetch_origin "$REPO_ROOT" >/dev/null 2>&1; then
    echo "Failed to fetch from origin"
    return 1
  fi

  # Resolve base reference
  local base_ref
  if [[ "$requested_base" == "default" ]]; then
    base_ref="origin/$(get_main_branch)"
  else
    base_ref="$requested_base"
  fi

  # Resolve to SHA
  local base_sha
  base_sha=$(resolve_base_sha "$base_ref")
  if [[ -z "$base_sha" ]]; then
    echo "Failed to resolve base reference: $base_ref"
    return 1
  fi

  # Output resolved SHA for caller to store
  echo "$base_sha"
  return 0
}

# 3. Workspace Safety Check
preflight_check_workspace_safety() {
  local task_dir="$1"
  local workspace_type="${2:-default_branch}"  # default_branch | task_workspace | other

  # Check if workspace is clean
  local check_result
  check_result=$(check_workspace_clean "$REPO_ROOT")
  local check_exit=$?

  if [[ $check_exit -ne 0 ]]; then
    # Parse JSON result
    local is_clean
    local has_critical
    is_clean=$(echo "$check_result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('clean', False))")
    has_critical=$(echo "$check_result" | python3 -c "import json,sys; print(json.load(sys.stdin).get('has_critical', False))")

    if [[ "$has_critical" == "True" ]]; then
      echo "Workspace has uncommitted changes in critical paths"
      echo "$check_result"
      return 1
    fi

    # If on main branch, any dirty state is critical
    if is_on_main_branch && [[ "$is_clean" != "True" ]]; then
      echo "Default branch workspace is dirty"
      echo "$check_result"
      return 1
    fi
  fi

  return 0
}

# 4. Concurrency Safety Check
preflight_check_concurrency() {
  local task_dir="$1"

  # Check if task is already claimed
  local current_status
  current_status=$(foundry_state_field "$task_dir" status 2>/dev/null || echo "pending")

  if [[ "$current_status" == "in_progress" ]]; then
    # Check if worker is still alive
    local worker_id
    worker_id=$(foundry_state_field "$task_dir" worker_id 2>/dev/null || echo "")

    if [[ -n "$worker_id" ]]; then
      # TODO: Check if worker process is actually running
      echo "Task already in progress by worker: $worker_id"
      return 1
    fi
  fi

  # Check for exclusive scope conflicts
  # TODO: Implement scope conflict detection across active tasks

  return 0
}

# 5. Policy Readiness Check
preflight_check_policy() {
  local task_dir="$1"

  # Ensure basic policies are defined
  # For now, we'll set defaults if not specified

  # Risk class should be defined
  local risk_class="${PIPELINE_RISK_CLASS:-medium}"

  # Expansion policy
  local expansion_policy="${PIPELINE_EXPANSION_POLICY:-bounded}"

  # Policies are valid
  return 0
}

# ── Main Preflight Entry Point ───────────────────────────────────────

# Run all preflight checks for a task
# Returns 0 if all checks pass, 1 otherwise
# On failure, sets stop_reason and stop_details in state.json
foundry_preflight_check() {
  local task_dir="$1"
  local requested_base="${2:-default}"

  # 1. Task Validity
  local validity_issues
  if ! validity_issues=$(preflight_check_task_validity "$task_dir" 2>&1); then
    foundry_stop_task_with_reason \
      "$task_dir" \
      "$STOP_REASON_SAFE_START_UNMET" \
      "system" \
      "$validity_issues" \
      '{"check": "task_validity", "issues": "'"$validity_issues"'"}'
    return 1
  fi

  # 2. Base Reference Validation
  local base_sha
  if ! base_sha=$(preflight_check_base_reference "$task_dir" "$requested_base" 2>&1); then
    foundry_stop_task_with_reason \
      "$task_dir" \
      "$STOP_REASON_BASE_RESOLUTION_FAILED" \
      "system" \
      "Failed to resolve base reference: $requested_base" \
      '{"check": "base_reference", "requested_base": "'"$requested_base"'", "error": "'"$base_sha"'"}'
    return 1
  fi

  # Store resolved base SHA
  foundry_update_state_field "$task_dir" "resolved_base_sha" "$base_sha"
  foundry_update_state_field "$task_dir" "resolved_base_ref" "$(get_main_branch)"

  # 3. Workspace Safety
  local workspace_check
  if ! workspace_check=$(preflight_check_workspace_safety "$task_dir" "default_branch" 2>&1); then
    # Determine specific stop reason
    local stop_reason="$STOP_REASON_DIRTY_DEFAULT_WORKSPACE"
    if ! is_on_main_branch; then
      stop_reason="$STOP_REASON_DIRTY_TASK_WORKSPACE"
    fi

    foundry_stop_task_with_reason \
      "$task_dir" \
      "$stop_reason" \
      "system" \
      "Workspace is dirty - cannot start task safely" \
      "$workspace_check"
    return 1
  fi

  # 4. Concurrency Safety
  local concurrency_check
  if ! concurrency_check=$(preflight_check_concurrency "$task_dir" 2>&1); then
    foundry_stop_task_with_reason \
      "$task_dir" \
      "$STOP_REASON_ALREADY_IN_PROGRESS" \
      "system" \
      "Task is already in progress" \
      '{"check": "concurrency", "error": "'"$concurrency_check"'"}'
    return 1
  fi

  # 5. Policy Readiness
  if ! preflight_check_policy "$task_dir" >/dev/null 2>&1; then
    foundry_stop_task_with_reason \
      "$task_dir" \
      "$STOP_REASON_SAFE_START_UNMET" \
      "system" \
      "Policy readiness check failed" \
      '{"check": "policy"}'
    return 1
  fi

  # All checks passed
  return 0
}

# ── Stop Task with Detailed Reason ───────────────────────────────────

# Stop a task with detailed reasoning
foundry_stop_task_with_reason() {
  local task_dir="$1"
  local stop_reason="$2"
  local stopped_by="$3"
  local message="$4"
  local stop_details_json="${5:-{}}"

  # Update state.json with extended stop information
  foundry_repair_state_file "$task_dir"

  python3 - "$task_dir" "$stop_reason" "$stopped_by" "$message" "$stop_details_json" <<'PYEOF'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

task_dir = Path(sys.argv[1])
stop_reason = sys.argv[2]
stopped_by = sys.argv[3]
message = sys.argv[4]
stop_details_raw = sys.argv[5]

state_path = task_dir / "state.json"
now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

# Load existing state
data = {}
if state_path.exists():
    try:
        data = json.loads(state_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
    except (json.JSONDecodeError, OSError):
        data = {}

# Parse stop_details
try:
    stop_details = json.loads(stop_details_raw)
except json.JSONDecodeError:
    stop_details = {"raw": stop_details_raw}

# Update state
data["status"] = "stopped"
data["stop_reason"] = stop_reason
data["stopped_by"] = stopped_by
data["stopped_at"] = now
data["updated_at"] = now
data["message"] = message

# Merge stop_details, handling potential existing details
if "stop_details" in data and isinstance(data["stop_details"], dict):
    data["stop_details"].update(stop_details)
else:
    data["stop_details"] = stop_details

# Write state
with open(state_path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=True, indent=2)
    fh.write("\n")
PYEOF

  # Log event
  pipeline_task_append_event "$task_dir" "task_stopped" "$message" "$stop_reason"

  # Update handoff.md with recovery instructions
  local handoff_file="$task_dir/handoff.md"
  cat >> "$handoff_file" <<EOF

---

## Task Stopped: $stop_reason

**Time**: $(date -u '+%Y-%m-%d %H:%M:%S UTC')
**Stopped by**: $stopped_by
**Message**: $message

### Details
\`\`\`json
$stop_details_json
\`\`\`

### Recovery Steps
1. Review the stop reason and details above
2. Fix the underlying issue (see specific guidance below)
3. Resume the task: \`./agentic-development/foundry.sh resume $(basename "$task_dir")\`

### Specific Guidance
EOF

  # Add specific recovery guidance based on stop_reason
  case "$stop_reason" in
    "$STOP_REASON_DIRTY_DEFAULT_WORKSPACE")
      cat >> "$handoff_file" <<'EOF'
- **Action**: Commit or stash uncommitted changes in the main branch
- **Commands**:
  ```bash
  git status  # Review changes
  git stash save "WIP: manual changes"  # or commit them
  ```
EOF
      ;;
    "$STOP_REASON_BASE_RESOLUTION_FAILED")
      cat >> "$handoff_file" <<'EOF'
- **Action**: Verify the base reference exists and is fetchable
- **Commands**:
  ```bash
  git fetch origin
  git branch -r | grep <base_branch>
  ```
EOF
      ;;
    "$STOP_REASON_EXCLUSIVE_CONFLICT")
      cat >> "$handoff_file" <<'EOF'
- **Action**: Wait for conflicting task to finish or stop it
- **Commands**:
  ```bash
  ./agentic-development/foundry.sh status
  ./agentic-development/foundry.sh stop <conflicting-task-slug>
  ```
EOF
      ;;
    "$STOP_REASON_ALREADY_IN_PROGRESS")
      cat >> "$handoff_file" <<'EOF'
- **Action**: Verify if task is actually running, or clean up stale state
- **Commands**:
  ```bash
  ./agentic-development/foundry.sh status
  # If stale, manually reset:
  # Edit state.json and set status to "pending"
  ```
EOF
      ;;
  esac
}

# Resume a stopped task (reset to pending)
foundry_resume_stopped_task() {
  local task_dir="$1"
  local current_status
  current_status=$(foundry_state_field "$task_dir" status 2>/dev/null || echo "")

  if [[ "$current_status" != "stopped" ]]; then
    echo "Task is not in stopped state (current: $current_status)"
    return 1
  fi

  # Clear stop fields and reset to pending
  python3 - "$task_dir" <<'PYEOF'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

task_dir = Path(sys.argv[1])
state_path = task_dir / "state.json"
now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

if not state_path.exists():
    print("state.json does not exist")
    sys.exit(1)

data = json.loads(state_path.read_text(encoding="utf-8"))
data["status"] = "pending"
data["updated_at"] = now

# Clear stop-specific fields
for key in ["stop_reason", "stopped_by", "stopped_at", "stop_details", "message"]:
    data.pop(key, None)

with open(state_path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=True, indent=2)
    fh.write("\n")
PYEOF

  pipeline_task_append_event "$task_dir" "task_resumed" "Task resumed from stopped state" ""
  echo "Task resumed and set to pending"
}
