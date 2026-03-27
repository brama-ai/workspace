#!/usr/bin/env bash

# Shared Foundry/Ultraworks runtime paths and task-state helpers.

: "${REPO_ROOT:=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"

FOUNDRY_HOME="${REPO_ROOT}/agentic-development"
RUNTIME_ROOT="${FOUNDRY_HOME}/runtime"
RUNTIME_LOG_DIR="${RUNTIME_ROOT}/logs"
LEGACY_FOUNDRY_TASK_ROOT="${FOUNDRY_HOME}/tasks"
LEGACY_FOUNDRY_QUEUE_ROOT="${FOUNDRY_HOME}/foundry-tasks"
PIPELINE_TASKS_ROOT="${PIPELINE_TASKS_ROOT:-${REPO_ROOT}/tasks}"
FOUNDRY_TASK_ROOT="${PIPELINE_TASKS_ROOT}"
FOUNDRY_TASK_ROOT_REL="${FOUNDRY_TASK_ROOT#"$REPO_ROOT"/}"

pipeline_slugify() {
  local text="${1:-unknown}"
  local title=""
  
  while IFS= read -r line; do
    local stripped="${line#"${line%%[![:space:]]*}"}"
    if [[ "$stripped" == "# "* ]]; then
      title="${stripped:2}"
      break
    fi
    if [[ -n "$stripped" && ! "$stripped" == "<!--"* ]]; then
      title="$stripped"
      break
    fi
  done <<< "$text"
  
  [[ -z "$title" ]] && title="unknown"
  
  local slug
  slug=$(echo "$title" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//')
  echo "${slug:0:60}"
}

ensure_pipeline_tasks_root() {
  mkdir -p "$PIPELINE_TASKS_ROOT"
}

ensure_runtime_root() {
  mkdir -p "$RUNTIME_ROOT" "$RUNTIME_LOG_DIR"
}

# Silent auto-cleanup: remove old completed/failed tasks and orphan artifacts.
# Runs in background, never blocks the caller, swallows all output.
auto_cleanup() {
  local cleanup_script="$FOUNDRY_HOME/lib/foundry-cleanup.sh"
  [[ -x "$cleanup_script" ]] || return 0
  "$cleanup_script" --apply >/dev/null 2>&1 &
}

runtime_log_file() {
  local workflow="$1"
  ensure_runtime_root
  echo "${RUNTIME_LOG_DIR}/${workflow}.log"
}

runtime_log() {
  local workflow="$1"
  shift || true
  local log_file
  log_file=$(runtime_log_file "$workflow")
  printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$log_file"
}

# ── Debug logging (FOUNDRY_DEBUG=true in .env.local) ─────────────────
if [[ "${FOUNDRY_DEBUG:-}" != "true" && -f "$REPO_ROOT/.env.local" ]]; then
  grep -qm1 '^FOUNDRY_DEBUG=true' "$REPO_ROOT/.env.local" 2>/dev/null && FOUNDRY_DEBUG=true
fi
FOUNDRY_DEBUG="${FOUNDRY_DEBUG:-false}"
FOUNDRY_DEBUG_LOG=""

_init_debug_log() {
  if [[ "$FOUNDRY_DEBUG" == "true" && -z "$FOUNDRY_DEBUG_LOG" ]]; then
    ensure_runtime_root
    FOUNDRY_DEBUG_LOG="${RUNTIME_LOG_DIR}/foundry-debug.log"
    debug_log "init" "Debug logging enabled" "pid=$$"
  fi
}

debug_log() {
  [[ "$FOUNDRY_DEBUG" != "true" ]] && return 0
  [[ -z "$FOUNDRY_DEBUG_LOG" ]] && _init_debug_log
  local category="$1"; shift || true
  local message="$1"; shift || true
  local extras=""
  while [[ $# -gt 0 ]]; do extras="${extras} $1"; shift; done
  printf '[%s] [%s] %s%s\n' "$(date '+%Y-%m-%d %H:%M:%S.%3N')" "$category" "$message" "$extras" >> "$FOUNDRY_DEBUG_LOG" 2>/dev/null
}

foundry_worker_config_file() {
  echo "${REPO_ROOT}/.opencode/pipeline/monitor-workers"
}

foundry_get_desired_workers() {
  local config_file
  config_file=$(foundry_worker_config_file)
  if [[ -f "$config_file" ]]; then
    local value
    value=$(tr -cd '0-9\n' < "$config_file" | head -n 1)
    if [[ -n "$value" && "$value" -ge 1 ]] 2>/dev/null; then
      echo "$value"
      return 0
    fi
  fi
  echo "${FOUNDRY_WORKERS:-${MONITOR_WORKERS:-1}}"
}

foundry_set_desired_workers() {
  local value="${1:-1}"
  if [[ -z "$value" || "$value" -lt 1 ]] 2>/dev/null; then
    value=1
  fi
  mkdir -p "$(dirname "$(foundry_worker_config_file)")"
  printf '%s\n' "$value" > "$(foundry_worker_config_file)"
}

pipeline_task_dir_path() {
  local slug="$1"
  local workflow="$2"
  echo "${PIPELINE_TASKS_ROOT}/${slug}--${workflow}"
}

pipeline_task_dir_create() {
  local slug="$1"
  local workflow="$2"
  local task_text="${3:-}"
  local task_dir
  local candidate
  local suffix=2

  ensure_pipeline_tasks_root
  task_dir=$(pipeline_task_dir_path "$slug" "$workflow")
  candidate="$task_dir"
  while [[ -e "$candidate" && ! -d "$candidate" ]]; do
    candidate="${task_dir}--${suffix}"
    suffix=$((suffix + 1))
  done
  task_dir="$candidate"

  mkdir -p "$task_dir" "$task_dir/artifacts"
  [[ -f "$task_dir/handoff.md" ]] || : > "$task_dir/handoff.md"
  [[ -f "$task_dir/events.jsonl" ]] || : > "$task_dir/events.jsonl"
  [[ -f "$task_dir/summary.md" ]] || : > "$task_dir/summary.md"

  if [[ -n "$task_text" ]]; then
    printf '%s\n' "$task_text" > "$task_dir/task.md"
  elif [[ ! -f "$task_dir/task.md" ]]; then
    printf '# %s\n' "$slug" > "$task_dir/task.md"
  fi

  echo "$task_dir"
}

pipeline_task_append_event() {
  local task_dir="$1"
  local event_type="$2"
  local message="${3:-}"
  local step="${4:-}"
  local event_file="$task_dir/events.jsonl"
  mkdir -p "$task_dir"
  
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local event="{\"timestamp\":\"$ts\",\"type\":\"$event_type\""
  [[ -n "$message" ]] && event="$event,\"message\":\"$message\""
  [[ -n "$step" ]] && event="$event,\"step\":\"$step\""
  event="$event}"
  echo "$event" >> "$event_file"
}

foundry_task_dir_for_slug() {
  local slug="$1"
  local matches=("$PIPELINE_TASKS_ROOT"/"${slug}"--foundry*)
  local first=""
  for first in "${matches[@]}"; do
    [[ -d "$first" ]] && { echo "$first"; return 0; }
  done
  return 1
}

foundry_task_dir_from_file() {
  local path="$1"
  [[ -n "$path" ]] || return 1
  
  local resolved
  resolved=$(cd "$(dirname "$path")" && pwd)/$(basename "$path") 2>/dev/null || return 1
  
  local parent="$resolved"
  while [[ -n "$parent" && "$parent" != "/" ]]; do
    parent=$(dirname "$parent")
    if [[ "$(dirname "$parent")" == "$PIPELINE_TASKS_ROOT" && "$parent" == *"--foundry"* ]]; then
      echo "$parent"
      return 0
    fi
    [[ "$parent" == "$PIPELINE_TASKS_ROOT" ]] && break
  done
  return 1
}

foundry_state_path() { echo "$1/state.json"; }
foundry_task_file() { echo "$1/task.md"; }
foundry_handoff_file() { echo "$1/handoff.md"; }
foundry_summary_file() { echo "$1/summary.md"; }
foundry_meta_file() { echo "$1/meta.json"; }
foundry_artifacts_dir() { echo "$1/artifacts"; }
foundry_checkpoint_file() { echo "$1/artifacts/checkpoint.json"; }
foundry_telemetry_dir() { echo "$1/artifacts/telemetry"; }

foundry_task_id_from_dir() {
  basename "$1"
}

foundry_task_slug_from_dir() {
  local base
  base=$(basename "$1")
  echo "${base%%--foundry*}"
}

foundry_task_exists() {
  [[ -d "$1" && -f "$1/task.md" ]]
}

foundry_repair_state_file() {
  local task_dir="$1"
  local task_file="${2:-$task_dir/task.md}"
  local state_file="$task_dir/state.json"
  local meta_file="$task_dir/meta.json"
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local task_id
  task_id=$(basename "$task_dir")
  
  mkdir -p "$task_dir"
  
  if [[ ! -f "$state_file" ]]; then
    echo "{\"task_id\":\"$task_id\",\"workflow\":\"foundry\",\"status\":\"pending\",\"started_at\":\"$now\",\"attempt\":1,\"task_file\":\"$task_file\",\"updated_at\":\"$now\"}" > "$state_file"
    return 0
  fi
  
  local existing
  existing=$(cat "$state_file" 2>/dev/null) || existing="{}"
  
  local branch=""
  if [[ -f "$meta_file" ]]; then
    branch=$(jq -r '.branch_name // empty' "$meta_file" 2>/dev/null) || branch=""
  fi
  
  echo "$existing" | jq --arg task_id "$task_id" \
    --arg now "$now" \
    --arg task_file "$task_file" \
    --arg branch "$branch" '
    {
      task_id: (.task_id // $task_id),
      workflow: "foundry",
      started_at: (.started_at // $now),
      attempt: ((.attempt // 1) | if . < 1 then 1 else . end),
      status: (.status // "pending"),
      current_step: (.current_step // null),
      resume_from: (.resume_from // null),
      updated_at: $now,
      task_file: (.task_file // $task_file),
      branch: (if $branch != "" then $branch elif .branch then .branch else null end)
    } + if .agents then {agents: .agents} else {} end
  ' > "$state_file"
}

foundry_write_state() {
  local task_dir="$1"
  local status="$2"
  local current_step="${3:-}"
  local resume_from="${4:-}"
  local task_file="${5:-$task_dir/task.md}"
  
  foundry_repair_state_file "$task_dir" "$task_file"
  
  local state_file="$task_dir/state.json"
  local meta_file="$task_dir/meta.json"
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  local task_id
  task_id=$(basename "$task_dir")
  
  local existing="{}"
  [[ -f "$state_file" ]] && existing=$(cat "$state_file" 2>/dev/null) || existing="{}"
  
  local meta_branch=""
  if [[ -f "$meta_file" ]]; then
    meta_branch=$(jq -r '.branch_name // empty' "$meta_file" 2>/dev/null) || meta_branch=""
  fi
  
  echo "$existing" | jq --arg task_id "$task_id" \
    --arg status "$status" \
    --arg current_step "$current_step" \
    --arg resume_from "$resume_from" \
    --arg task_file "$task_file" \
    --arg now "$now" \
    --arg meta_branch "$meta_branch" '
    {
      task_id: $task_id,
      workflow: "foundry",
      status: $status,
      current_step: (if $current_step != "" then $current_step else null end),
      resume_from: (if $resume_from != "" then $resume_from else null end),
      task_file: $task_file,
      updated_at: $now,
      started_at: (.started_at // $now),
      attempt: (((.attempt // 1) | tonumber) | if . < 1 then 1 else . end),
      branch: (if $meta_branch != "" then $meta_branch elif .branch then .branch else null end)
    }
  ' > "$state_file"
}

foundry_update_state_field() {
  local task_dir="$1"
  local key="$2"
  local value="$3"
  
  foundry_repair_state_file "$task_dir"
  
  local state_file="$task_dir/state.json"
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  
  local existing="{}"
  [[ -f "$state_file" ]] && existing=$(cat "$state_file" 2>/dev/null) || existing="{}"
  
  if [[ "$value" == "__NULL__" ]]; then
    echo "$existing" | jq --arg key "$key" --arg now "$now" '.[$key] = null | .updated_at = $now' > "$state_file"
  else
    echo "$existing" | jq --arg key "$key" --arg value "$value" --arg now "$now" '.[$key] = $value | .updated_at = $now' > "$state_file"
  fi
}

foundry_set_state_status() {
  local task_dir="$1"
  local status="$2"
  local current_step="${3:-}"
  local resume_from="${4:-}"
  
  foundry_repair_state_file "$task_dir"
  
  local state_file="$task_dir/state.json"
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  
  local existing="{}"
  [[ -f "$state_file" ]] && existing=$(cat "$state_file" 2>/dev/null) || existing="{}"
  
  echo "$existing" | jq --arg status "$status" \
    --arg current_step "$current_step" \
    --arg resume_from "$resume_from" \
    --arg now "$now" '
    .status = $status |
    .current_step = (if $current_step != "" then $current_step else null end) |
    .resume_from = (if $resume_from != "" then $resume_from else null end) |
    .updated_at = $now
  ' > "$state_file"
}

foundry_increment_attempt() {
  local task_dir="$1"
  
  foundry_repair_state_file "$task_dir"
  
  local state_file="$task_dir/state.json"
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  
  local existing="{}"
  [[ -f "$state_file" ]] && existing=$(cat "$state_file" 2>/dev/null) || existing="{}"
  
  echo "$existing" | jq --arg now "$now" '
    .attempt = ((.attempt // 1) | tonumber | . + 1) |
    .updated_at = $now
  ' > "$state_file"
}

foundry_state_field() {
  local task_dir="$1"
  local key="$2"
  local state_file="$task_dir/state.json"
  
  [[ -f "$state_file" ]] || return 0
  jq -r --arg key "$key" '.[$key] // empty' "$state_file" 2>/dev/null || true
}

# ── Atomic task claiming for parallel workers ───────────────────────
# Returns 0 if task was claimed, 1 if already taken.
# Uses fcntl file locking via Python for atomicity.
foundry_claim_task() {
  local task_dir="$1"
  local worker_id="${2:-main}"
  python3 - "$task_dir" "$worker_id" <<'PYEOF'
import fcntl
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

task_dir = Path(sys.argv[1])
worker_id = sys.argv[2]
state_path = task_dir / "state.json"
lock_path = task_dir / ".claim.lock"

# Create lock file
lock_path.touch(exist_ok=True)
lock_fd = open(lock_path, "r+")

try:
    fcntl.flock(lock_fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
except (OSError, IOError):
    # Another process holds the lock
    lock_fd.close()
    raise SystemExit(1)

try:
    data = {}
    if state_path.exists():
        try:
            data = json.loads(state_path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                data = {}
        except (json.JSONDecodeError, OSError):
            data = {}

    status = data.get("status", "pending")
    if status != "pending":
        # Already claimed or not available
        raise SystemExit(1)

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    data["status"] = "in_progress"
    data["worker_id"] = worker_id
    data["claimed_at"] = now
    data["updated_at"] = now

    with open(state_path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=True, indent=2)
        fh.write("\n")

    # Success
    raise SystemExit(0)
finally:
    fcntl.flock(lock_fd.fileno(), fcntl.LOCK_UN)
    lock_fd.close()
PYEOF
}

# Release a claimed task back to pending (e.g. worker crashed before starting)
foundry_release_task() {
  local task_dir="$1"
  local current_status
  current_status=$(foundry_state_field "$task_dir" status 2>/dev/null || echo "")
  if [[ "$current_status" == "in_progress" ]]; then
    foundry_set_state_status "$task_dir" "pending" "" ""
  fi
}

foundry_stop_task() {
  local task_dir="$1"
  local current_status
  current_status=$(foundry_state_field "$task_dir" status 2>/dev/null || echo "")
  if [[ "$current_status" == "in_progress" || "$current_status" == "pending" ]]; then
    foundry_set_state_status "$task_dir" "stopped" "" ""
  fi
}

foundry_resume_stopped_task() {
  local task_dir="$1"
  local current_status
  current_status=$(foundry_state_field "$task_dir" status 2>/dev/null || echo "")
  if [[ "$current_status" != "stopped" ]]; then
    echo "Warning: Task is not in stopped state (current: $current_status)" >&2
    return 1
  fi

  # Use foundry-preflight.sh resume if available, otherwise fallback to basic resume
  if [[ -f "$REPO_ROOT/agentic-development/lib/foundry-preflight.sh" ]]; then
    # Source preflight and use its resume function (clears stop fields properly)
    # shellcheck source=/dev/null
    source "$REPO_ROOT/agentic-development/lib/foundry-preflight.sh"
    # foundry-preflight.sh has its own foundry_resume_stopped_task that clears stop fields
    return 0
  fi

  # Fallback: basic resume
  foundry_set_state_status "$task_dir" "pending" "" ""
  pipeline_task_append_event "$task_dir" "task_resumed" "Task resumed from stopped state" ""
}

# Find and claim the next pending task (priority-sorted). Prints task_dir on success.
foundry_claim_next_task() {
  local worker_id="${1:-main}"
  python3 - "$PIPELINE_TASKS_ROOT" "$worker_id" <<'PYEOF'
import fcntl
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

root = Path(sys.argv[1])
worker_id = sys.argv[2]

# Collect pending tasks with priority
candidates = []
for task_dir in sorted(root.glob("*--foundry*")):
    if not task_dir.is_dir():
        continue
    state_path = task_dir / "state.json"
    status = "pending"
    if state_path.exists():
        try:
            status = json.loads(state_path.read_text(encoding="utf-8")).get("status", "pending")
        except (json.JSONDecodeError, OSError):
            status = "pending"
    if status != "pending":
        continue

    # Read priority from task.md
    priority = 1
    task_md = task_dir / "task.md"
    if task_md.exists():
        try:
            first_line = task_md.read_text(encoding="utf-8").split("\n", 1)[0]
            m = re.search(r"<!--\s*priority:\s*(\d+)\s*-->", first_line)
            if m:
                priority = int(m.group(1))
        except (OSError, ValueError):
            pass

    candidates.append((priority, task_dir))

# Sort by priority descending
candidates.sort(key=lambda x: x[0], reverse=True)

# Try to claim each one atomically
now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

for _, task_dir in candidates:
    state_path = task_dir / "state.json"
    lock_path = task_dir / ".claim.lock"
    lock_path.touch(exist_ok=True)

    try:
        lock_fd = open(lock_path, "r+")
        fcntl.flock(lock_fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, IOError):
        continue  # Another worker is claiming this one

    try:
        data = {}
        if state_path.exists():
            try:
                data = json.loads(state_path.read_text(encoding="utf-8"))
                if not isinstance(data, dict):
                    data = {}
            except (json.JSONDecodeError, OSError):
                data = {}

        if data.get("status", "pending") != "pending":
            continue  # Already claimed between check and lock

        # Ensure all required fields exist — covers tasks created manually
        # (task.md placed in tasks/ without going through foundry_create_task_dir)
        data.setdefault("task_id", task_dir.name)
        data.setdefault("workflow", "foundry")
        data.setdefault("attempt", 1)
        data.setdefault("current_step", None)
        data.setdefault("resume_from", None)
        data.setdefault("branch", None)
        data.setdefault("task_file", str(task_dir / "task.md"))
        data.setdefault("started_at", now)

        data["status"] = "in_progress"
        data["worker_id"] = worker_id
        data["claimed_at"] = now
        data["updated_at"] = now

        with open(state_path, "w", encoding="utf-8") as fh:
            json.dump(data, fh, ensure_ascii=True, indent=2)
            fh.write("\n")

        print(task_dir)
        raise SystemExit(0)
    finally:
        fcntl.flock(lock_fd.fileno(), fcntl.LOCK_UN)
        lock_fd.close()

# No task available
raise SystemExit(1)
PYEOF
}

# ── Git worktree management for parallel workers ────────────────────
WORKTREE_BASE="${REPO_ROOT}/.pipeline-worktrees"

foundry_worktree_path() {
  local worker_id="$1"
  echo "${WORKTREE_BASE}/${worker_id}"
}

foundry_create_worktree() {
  local worker_id="$1"
  local wt_path
  wt_path=$(foundry_worktree_path "$worker_id")

  if [[ -d "$wt_path" ]]; then
    # Worktree exists — verify it's valid, reuse it
    if git -C "$REPO_ROOT" worktree list --porcelain 2>/dev/null | grep -qF "$wt_path"; then
      # Pull latest from main branch
      local main_branch
      main_branch=$(git -C "$REPO_ROOT" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@refs/remotes/origin/@@' || echo "main")
      git -C "$wt_path" checkout "$main_branch" 2>/dev/null || true
      git -C "$wt_path" reset --hard "origin/$main_branch" 2>/dev/null || true
      echo "$wt_path"
      return 0
    fi
    # Stale directory — remove and recreate
    rm -rf "$wt_path"
    git -C "$REPO_ROOT" worktree prune 2>/dev/null || true
  fi

  mkdir -p "$WORKTREE_BASE"

  # Determine main branch
  local main_branch
  main_branch=$(git -C "$REPO_ROOT" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@refs/remotes/origin/@@' || echo "main")

  # Create worktree from origin/main (not HEAD) to ensure all workers start from main
  local wt_branch="pipeline-worker-${worker_id}"
  git -C "$REPO_ROOT" branch -D "$wt_branch" 2>/dev/null || true
  git -C "$REPO_ROOT" worktree add -b "$wt_branch" "$wt_path" "origin/$main_branch" 2>/dev/null || {
    # Fallback: try local main branch
    git -C "$REPO_ROOT" worktree add -b "$wt_branch" "$wt_path" "$main_branch" 2>/dev/null || {
      # Last resort: detached HEAD from origin/main
      git -C "$REPO_ROOT" worktree add --detach "$wt_path" "origin/$main_branch" 2>/dev/null || return 1
    }
  }

  echo "$wt_path"
}

foundry_cleanup_worktree() {
  local worker_id="$1"
  local wt_path
  wt_path=$(foundry_worktree_path "$worker_id")
  [[ -d "$wt_path" ]] || return 0
  git -C "$REPO_ROOT" worktree remove --force "$wt_path" 2>/dev/null || rm -rf "$wt_path"
  git -C "$REPO_ROOT" worktree prune 2>/dev/null || true
}

foundry_list_active_workers() {
  # List worker IDs that are currently running (have live foundry-run.sh processes)
  local pids
  pids=$(pgrep -f 'foundry-run\.sh' 2>/dev/null || true)
  [[ -z "$pids" ]] && return 0
  ps -o args= -p $pids 2>/dev/null | while IFS= read -r args; do
    if [[ "$args" =~ \.pipeline-worktrees/(worker-[0-9]+) ]]; then
      echo "${BASH_REMATCH[1]}"
    elif [[ "$args" =~ PIPELINE_WORKER_ID=([^ ]+) ]]; then
      echo "${BASH_REMATCH[1]}"
    fi
  done | sort -u
}

foundry_count_active_workers() {
  local count=0
  while IFS= read -r _; do
    count=$((count + 1))
  done < <(foundry_list_active_workers)
  echo "$count"
}

foundry_state_upsert_agent() {
  local task_dir="$1"
  local agent="$2"
  local status="$3"
  local model="${4:-}"
  local duration_seconds="${5:-}"
  local input_tokens="${6:-}"
  local output_tokens="${7:-}"
  local cost="${8:-}"
  local call_count="${9:-1}"
  
  foundry_repair_state_file "$task_dir"
  
  local state_file="$task_dir/state.json"
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  
  local existing="{}"
  [[ -f "$state_file" ]] && existing=$(cat "$state_file" 2>/dev/null) || existing="{}"
  
  echo "$existing" | jq --arg agent "$agent" \
    --arg status "$status" \
    --arg model "$model" \
    --argjson duration "${duration_seconds:-0}" \
    --argjson input "${input_tokens:-0}" \
    --argjson output "${output_tokens:-0}" \
    --argjson cost "${cost:-0}" \
    --argjson call_count "${call_count:-1}" \
    --arg now "$now" '
    .agents = (.agents // []) |
    (first(.agents[] | select(.agent == $agent)) // null) as $existing |
    if $existing then
      .agents = [.agents[] | if .agent == $agent then
        .status = $status |
        .model = (if $model != "" then $model else .model // "n/d" end) |
        .duration_seconds = (if $duration > 0 then $duration else .duration_seconds // "n/d" end) |
        .input_tokens = (if $input > 0 then $input else .input_tokens // "n/d" end) |
        .output_tokens = (if $output > 0 then $output else .output_tokens // "n/d" end) |
        .cost = (if $cost > 0 then $cost else .cost // "n/d" end) |
        .call_count = (if $call_count > 0 then $call_count else .call_count // 1 end) |
        .updated_at = $now
      else . end]
    else
      .agents += [{
        agent: $agent,
        status: $status,
        model: (if $model != "" then $model else "n/d" end),
        duration_seconds: (if $duration > 0 then $duration else "n/d" end),
        input_tokens: (if $input > 0 then $input else "n/d" end),
        output_tokens: (if $output > 0 then $output else "n/d" end),
        cost: (if $cost > 0 then $cost else "n/d" end),
        call_count: (if $call_count > 0 then $call_count else 1 end),
        updated_at: $now
      }]
    end |
    .updated_at = $now
  ' > "$state_file"
}

# Write all planned agents to state.json as "pending" + set profile
# Called ONCE after planner determines the agent list, before execution starts.
foundry_state_set_planned_agents() {
  local task_dir="$1"
  local profile="$2"
  shift 2
  local agents=("$@")
  
  foundry_repair_state_file "$task_dir"
  
  local state_file="$task_dir/state.json"
  local now
  now=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  
  local existing="{}"
  [[ -f "$state_file" ]] && existing=$(cat "$state_file" 2>/dev/null) || existing="{}"
  
  local agents_json="[]"
  for name in "${agents[@]}"; do
    local existing_agent
    existing_agent=$(echo "$existing" | jq --arg name "$name" 'first(.agents[]? | select(.agent == $name)) // null' 2>/dev/null)
    if [[ "$existing_agent" != "null" && -n "$existing_agent" ]]; then
      agents_json=$(echo "$agents_json" | jq --argjson agent "$existing_agent" '. + [$agent]')
    else
      agents_json=$(echo "$agents_json" | jq --arg name "$name" '. + [{agent: $name, status: "pending", model: "", duration_seconds: 0, input_tokens: 0, output_tokens: 0, cost: 0, call_count: 0, updated_at: ""}]')
    fi
  done
  
  echo "$existing" | jq --argjson agents "$agents_json" --arg profile "$profile" --arg now "$now" '
    .agents = $agents |
    .profile = $profile |
    .updated_at = $now
  ' > "$state_file"
}

foundry_create_task_dir() {
  local task_text="$1"
  local slug="${2:-}"
  [[ -n "$slug" ]] || slug=$(pipeline_slugify "$task_text")
  local task_dir
  task_dir=$(pipeline_task_dir_create "$slug" "foundry" "$task_text")
  mkdir -p "$(foundry_artifacts_dir "$task_dir")" "$(foundry_telemetry_dir "$task_dir")"
  [[ -f "$(foundry_meta_file "$task_dir")" ]] || cat > "$(foundry_meta_file "$task_dir")" <<EOF
{
  "workflow": "foundry",
  "task_slug": "${slug}",
  "created_at": "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
}
EOF
  [[ -f "$(foundry_state_path "$task_dir")" ]] || foundry_write_state "$task_dir" "pending" "" ""
  echo "$task_dir"
}

# Ensure state.json exists for a task directory.
# If task.md exists but state.json does not, creates state.json with status=pending.
# This covers tasks created manually (by copying task.md into tasks/) without going
# through foundry_create_task_dir(), which is the only other place state.json is written.
foundry_ensure_state_json() {
  local task_dir="$1"
  local state_path="$task_dir/state.json"
  [[ -f "$state_path" ]] && return 0
  [[ -f "$task_dir/task.md" ]] || return 0
  foundry_write_state "$task_dir" "pending" "" "" "$task_dir/task.md"
}

foundry_list_task_dirs() {
  ensure_pipeline_tasks_root
  local dir
  while IFS= read -r dir; do
    foundry_ensure_state_json "$dir"
    echo "$dir"
  done < <(find "$PIPELINE_TASKS_ROOT" -maxdepth 1 -type d -name '*--foundry*' | sort)
}

foundry_find_tasks_by_status() {
  local wanted="${1:-pending}"
  python3 - "$PIPELINE_TASKS_ROOT" "$wanted" <<'PYEOF'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

root = Path(sys.argv[1])
wanted = set(sys.argv[2].split(","))
now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

for task_dir in sorted(root.glob("*--foundry*")):
    if not task_dir.is_dir():
        continue
    state_path = task_dir / "state.json"
    # Auto-create state.json for manually-placed task.md files
    if not state_path.exists() and (task_dir / "task.md").exists():
        payload = {
            "task_id": task_dir.name,
            "workflow": "foundry",
            "started_at": now,
            "attempt": 1,
            "status": "pending",
            "current_step": None,
            "resume_from": None,
            "updated_at": now,
            "task_file": str(task_dir / "task.md"),
            "branch": None,
        }
        try:
            state_path.write_text(json.dumps(payload, indent=2, ensure_ascii=True) + "\n")
        except OSError:
            pass
    status = "pending"
    if state_path.exists():
        try:
            status = json.loads(state_path.read_text(encoding="utf-8")).get("status", "pending")
        except json.JSONDecodeError:
            status = "pending"
    if status in wanted:
        print(task_dir)
PYEOF
}

foundry_task_counts() {
  python3 - "$PIPELINE_TASKS_ROOT" <<'PYEOF'
import json
import sys
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

root = Path(sys.argv[1])
counts = Counter()
now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

for task_dir in root.glob("*--foundry*"):
    if not task_dir.is_dir():
        continue
    state_path = task_dir / "state.json"
    # Auto-create state.json for manually-placed task.md files
    if not state_path.exists() and (task_dir / "task.md").exists():
        payload = {
            "task_id": task_dir.name,
            "workflow": "foundry",
            "started_at": now,
            "attempt": 1,
            "status": "pending",
            "current_step": None,
            "resume_from": None,
            "updated_at": now,
            "task_file": str(task_dir / "task.md"),
            "branch": None,
        }
        try:
            state_path.write_text(json.dumps(payload, indent=2, ensure_ascii=True) + "\n")
        except OSError:
            pass
    status = "pending"
    if state_path.exists():
        try:
            status = json.loads(state_path.read_text(encoding="utf-8")).get("status", "pending")
        except json.JSONDecodeError:
            status = "pending"
    counts[status] += 1
for key in ["pending", "in_progress", "completed", "failed", "suspended", "cancelled", "stopped"]:
    print(f"{key}={counts.get(key, 0)}")
PYEOF
}

foundry_migrate_legacy_state() {
  local queue_root="$1"
  local status="$2"
  local src_dir="$queue_root/$status"
  [[ -d "$src_dir" ]] || return 0
  local file task_dir slug cleaned
  for file in "$src_dir"/*.md; do
    [[ -f "$file" ]] || continue
    slug=$(basename "$file" .md)
    task_dir=$(foundry_task_dir_for_slug "$slug" || true)
    if [[ -z "$task_dir" ]]; then
      cleaned=$(sed '/^<!-- batch:.*-->$/d;/^<!-- suspended:.*-->$/d' "$file")
      task_dir=$(foundry_create_task_dir "$cleaned" "$slug")
    fi
    if [[ ! -f "$task_dir/task.md" || ! -s "$task_dir/task.md" ]]; then
      sed '/^<!-- batch:.*-->$/d;/^<!-- suspended:.*-->$/d' "$file" > "$task_dir/task.md"
    fi
    case "$status" in
      todo) foundry_set_state_status "$task_dir" "pending" "" "" ;;
      in-progress) foundry_set_state_status "$task_dir" "in_progress" "" "" ;;
      done|archive) foundry_set_state_status "$task_dir" "completed" "" "" ;;
      failed) foundry_set_state_status "$task_dir" "failed" "" "" ;;
      suspended) foundry_set_state_status "$task_dir" "suspended" "" "" ;;
      stopped) foundry_set_state_status "$task_dir" "stopped" "" "" ;;
    esac
  done
}

foundry_migrate_legacy_artifacts() {
  local src_root="$1"
  local artifact_root="$src_root/artifacts"
  local summary_root="$src_root/summary"
  [[ -d "$artifact_root" || -d "$summary_root" ]] || return 0

  local dir slug task_dir
  if [[ -d "$artifact_root" ]]; then
    for dir in "$artifact_root"/*; do
      [[ -d "$dir" ]] || continue
      slug=$(basename "$dir")
      task_dir=$(foundry_task_dir_for_slug "$slug" || true)
      [[ -n "$task_dir" ]] || task_dir=$(foundry_create_task_dir "# ${slug}" "$slug")
      mkdir -p "$(foundry_artifacts_dir "$task_dir")"
      if [[ ! -e "$(foundry_artifacts_dir "$task_dir")/$(basename "$dir")" ]]; then
        cp -R "$dir" "$(foundry_artifacts_dir "$task_dir")/" 2>/dev/null || true
      fi
    done
  fi

  local summary_file summary_name
  if [[ -d "$summary_root" ]]; then
    for summary_file in "$summary_root"/*.md; do
      [[ -f "$summary_file" ]] || continue
      summary_name=$(basename "$summary_file")
      slug=$(printf '%s' "$summary_name" | sed -E 's/^[a-z]-[0-9_]+-//; s/\.md$//')
      task_dir=$(foundry_task_dir_for_slug "$slug" || true)
      [[ -n "$task_dir" ]] || continue
      if [[ ! -s "$(foundry_summary_file "$task_dir")" ]]; then
        cp "$summary_file" "$(foundry_summary_file "$task_dir")" 2>/dev/null || true
      fi
    done
  fi
}

maybe_migrate_legacy_foundry_tasks() {
  ensure_pipeline_tasks_root
  [[ -d "$LEGACY_FOUNDRY_TASK_ROOT" || -d "$LEGACY_FOUNDRY_QUEUE_ROOT" ]] || return 0
  foundry_migrate_legacy_state "$LEGACY_FOUNDRY_TASK_ROOT" "todo"
  foundry_migrate_legacy_state "$LEGACY_FOUNDRY_TASK_ROOT" "in-progress"
  foundry_migrate_legacy_state "$LEGACY_FOUNDRY_TASK_ROOT" "done"
  foundry_migrate_legacy_state "$LEGACY_FOUNDRY_TASK_ROOT" "failed"
  foundry_migrate_legacy_state "$LEGACY_FOUNDRY_TASK_ROOT" "suspended"
  foundry_migrate_legacy_state "$LEGACY_FOUNDRY_QUEUE_ROOT" "todo"
  foundry_migrate_legacy_state "$LEGACY_FOUNDRY_QUEUE_ROOT" "in-progress"
  foundry_migrate_legacy_state "$LEGACY_FOUNDRY_QUEUE_ROOT" "done"
  foundry_migrate_legacy_state "$LEGACY_FOUNDRY_QUEUE_ROOT" "failed"
  foundry_migrate_legacy_state "$LEGACY_FOUNDRY_QUEUE_ROOT" "suspended"
  foundry_migrate_legacy_state "$LEGACY_FOUNDRY_QUEUE_ROOT" "archive"
  foundry_migrate_legacy_artifacts "$LEGACY_FOUNDRY_TASK_ROOT"
  foundry_migrate_legacy_artifacts "$LEGACY_FOUNDRY_QUEUE_ROOT"
}

ensure_foundry_task_root() {
  ensure_pipeline_tasks_root
}

foundry_task_root_empty() {
  ! find "$PIPELINE_TASKS_ROOT" -maxdepth 1 -type d -name '*--foundry*' | read -r _
}

foundry_is_batch_running() {
  pgrep -f 'agentic-development/lib/foundry-batch\.sh' &>/dev/null
}

# ── Zombie process cleanup ───────────────────────────────────────────
# Finds and cleans up zombie .opencode processes and stale batch lock.
# Returns number of zombies cleaned.
foundry_cleanup_zombies() {
  local cleaned=0

  # 1. Find zombie .opencode processes (state Z)
  local zombie_pids
  zombie_pids=$(ps -eo pid,stat,comm 2>/dev/null \
    | awk '$2 ~ /^Z/ && $3 ~ /opencode/ {print $1}' || true)

  if [[ -n "$zombie_pids" ]]; then
    local count
    count=$(echo "$zombie_pids" | wc -l | tr -d ' ')
    cleaned=$((cleaned + count))
    # Zombies can't be killed directly — their parent must reap them.
    # We can only log them; the OS will clean them when parent exits.
  fi

  # 2. Check and clean stale batch lock
  local lockfile="${REPO_ROOT}/.opencode/pipeline/.batch.lock"
  if [[ -f "$lockfile" ]]; then
    local lock_pid
    lock_pid=$(cat "$lockfile" 2>/dev/null || true)
    if [[ -n "$lock_pid" ]]; then
      # Check if PID is alive AND not a zombie
      local pid_stat
      pid_stat=$(cat "/proc/${lock_pid}/status" 2>/dev/null | awk '/^State:/{print $2}' || true)
      if [[ -z "$pid_stat" ]] || [[ "$pid_stat" == "Z" ]]; then
        # PID is dead or zombie — remove stale lock
        rm -f "$lockfile"
        cleaned=$((cleaned + 1))
      fi
    fi
  fi

  echo "$cleaned"
}

# Print zombie/process status report (for monitor display)
foundry_process_status() {
  python3 - "$REPO_ROOT" <<'PYEOF'
import subprocess, sys, os, json
from pathlib import Path

repo_root = sys.argv[1]
lockfile = Path(repo_root) / ".opencode/pipeline/.batch.lock"
log_dir = Path(repo_root) / "agentic-development/runtime/logs"

result = {"workers": [], "zombies": [], "lock": None}

# Batch lock
if lockfile.exists():
    try:
        pid = int(lockfile.read_text().strip())
        stat_file = Path(f"/proc/{pid}/status")
        state = "unknown"
        if stat_file.exists():
            for line in stat_file.read_text().split("\n"):
                if line.startswith("State:"):
                    state = line.split()[1]
                    break
        result["lock"] = {"pid": pid, "state": state, "zombie": state == "Z"}
    except Exception:
        pass

# Active foundry workers
try:
    out = subprocess.check_output(
        ["ps", "-eo", "pid,stat,etime,args"],
        text=True, stderr=subprocess.DEVNULL
    )
    for line in out.strip().split("\n")[1:]:
        parts = line.split(None, 3)
        if len(parts) < 4:
            continue
        pid, stat, etime, args = parts
        if "foundry" in args or "opencode" in args.lower():
            is_zombie = stat.startswith("Z")
            entry = {
                "pid": int(pid),
                "stat": stat,
                "etime": etime,
                "args": args[:80],
                "zombie": is_zombie,
                "log": None,
            }
            # Find matching log file
            if log_dir.exists():
                logs = sorted(log_dir.glob("*.log"), key=lambda p: p.stat().st_mtime, reverse=True)
                if logs:
                    entry["log"] = str(logs[0])
            if is_zombie:
                result["zombies"].append(entry)
            else:
                result["workers"].append(entry)
except Exception:
    pass

print(json.dumps(result))
PYEOF
}

# Check if all agents in a task completed (summarizer done = pipeline finished).
# Returns 0 if all agents done, 1 otherwise.
_foundry_all_agents_done() {
  local task_dir="$1"
  python3 -c "
import json, sys
from pathlib import Path
state = json.loads((Path(sys.argv[1]) / 'state.json').read_text())
agents = state.get('agents', [])
if agents and any(a.get('agent','').endswith('summarizer') and a.get('status')=='done' for a in agents):
    sys.exit(0)
sys.exit(1)
" "$task_dir" 2>/dev/null
}

# Cancel all in_progress tasks (e.g. when batch workers are stopped).
# Tasks where all agents completed → completed (stuck in finalization).
# Tasks still mid-pipeline → cancelled.
foundry_cancel_in_progress_tasks() {
  local tasks_root="${PIPELINE_TASKS_ROOT:-$FOUNDRY_TASK_ROOT}"
  local task_dir
  for task_dir in "$tasks_root"/*--foundry*/; do
    [[ -d "$task_dir" ]] || continue
    local task_status
    task_status=$(foundry_state_field "$task_dir" status 2>/dev/null || echo "")
    if [[ "$task_status" == "in_progress" ]]; then
      if _foundry_all_agents_done "$task_dir"; then
        foundry_set_state_status "$task_dir" "completed" "" ""
        pipeline_task_append_event "$task_dir" "stopped" "All agents done — marking completed" ""
      else
        foundry_set_state_status "$task_dir" "cancelled" "" ""
        pipeline_task_append_event "$task_dir" "stopped" "Pipeline stopped by user" ""
      fi
    fi
  done
}

# ── Q&A helpers (Human-in-the-Loop protocol) ────────────────────────

# Return the path to the qa.json file for a task directory.
foundry_qa_file() {
  echo "$1/qa.json"
}

# Count unanswered questions in qa.json.
# Prints the count (0 if file missing or no questions).
foundry_qa_unanswered_count() {
  local task_dir="$1"
  local qa_file
  qa_file=$(foundry_qa_file "$task_dir")
  [[ -f "$qa_file" ]] || { echo 0; return; }
  jq '[.questions[]? | select(.answer == null)] | length' "$qa_file" 2>/dev/null || echo 0
}

# Count unanswered BLOCKING questions in qa.json.
# Prints the count (0 if file missing or no blocking questions).
foundry_qa_blocking_unanswered_count() {
  local task_dir="$1"
  local qa_file
  qa_file=$(foundry_qa_file "$task_dir")
  [[ -f "$qa_file" ]] || { echo 0; return; }
  jq '[.questions[]? | select(.priority == "blocking" and .answer == null)] | length' "$qa_file" 2>/dev/null || echo 0
}

# Count total questions and answered questions in qa.json.
# Prints "answered/total" (e.g. "1/3").
foundry_qa_progress() {
  local task_dir="$1"
  local qa_file
  qa_file=$(foundry_qa_file "$task_dir")
  [[ -f "$qa_file" ]] || { echo "0/0"; return; }
  jq -r '"\([.questions[]? | select(.answer != null)] | length)/\(.questions | length)"' "$qa_file" 2>/dev/null || echo "0/0"
}

# ── Q&A Timeout Strategy (Section 13 of openspec-human-in-the-loop.md) ──────
#
# Reads qa_timeout, qa_on_timeout, qa_reminder_at from pipeline-plan.json.
# Per-question timeout override supported via qa.json fields: timeout, on_timeout, default_answer.
#
# Strategies:
#   fail     (default) — set task status=failed, stop_reason=qa_timeout
#   skip               — mark unanswered questions as skipped, continue pipeline
#   fallback           — use agent's default_answer from qa.json, continue pipeline
#
# Reminders sent via Telegram at 50% and 90% of timeout.

# Parse a human-readable duration string (e.g. "4h", "30m", "1h30m", "3600") into seconds.
# Returns 0 on parse failure (no timeout).
_foundry_parse_duration_seconds() {
  local raw="${1:-0}"
  local total=0
  
  [[ -z "$raw" || "$raw" == "0" ]] && { echo 0; return; }
  
  if [[ "$raw" =~ ^[0-9]+$ ]]; then
    echo "$raw"
    return
  fi
  
  while [[ "$raw" =~ ([0-9]+)([hHmMsS]?) ]]; do
    local val="${BASH_REMATCH[1]}"
    local unit="${BASH_REMATCH[2],,}"
    case "$unit" in
      h) total=$((total + val * 3600)) ;;
      m) total=$((total + val * 60)) ;;
      s|"") total=$((total + val)) ;;
    esac
    raw="${raw#*${BASH_REMATCH[0]}}"
  done
  
  echo "$total"
}

# Format seconds into a human-readable string (e.g. 3600 → "1h", 5400 → "1h30m").
_foundry_format_duration() {
  local secs="${1:-0}"
  local result=""
  
  [[ "$secs" -le 0 ]] && { echo "0s"; return; }
  
  local h=$((secs / 3600))
  local m=$(((secs % 3600) / 60))
  local s=$((secs % 60))
  
  [[ "$h" -gt 0 ]] && result="${result}${h}h"
  [[ "$m" -gt 0 ]] && result="${result}${m}m"
  [[ "$s" -gt 0 ]] && result="${result}${s}s"
  
  echo "${result:-0s}"
}

# Read qa_timeout config from pipeline-plan.json (or task-level plan).
# Returns timeout in seconds (0 = no timeout).
foundry_qa_timeout_seconds() {
  local task_dir="$1"
  local plan_file="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}/pipeline-plan.json"
  local raw_timeout="4h"  # default

  # Try task-level plan first, then repo-root plan
  local task_plan="$task_dir/pipeline-plan.json"
  if [[ -f "$task_plan" ]]; then
    local t
    t=$(jq -r '.qa_timeout // empty' "$task_plan" 2>/dev/null || true)
    [[ -n "$t" ]] && raw_timeout="$t"
  elif [[ -f "$plan_file" ]]; then
    local t
    t=$(jq -r '.qa_timeout // empty' "$plan_file" 2>/dev/null || true)
    [[ -n "$t" ]] && raw_timeout="$t"
  fi

  _foundry_parse_duration_seconds "$raw_timeout"
}

# Read qa_on_timeout config (fail|skip|fallback). Default: fail.
foundry_qa_on_timeout() {
  local task_dir="$1"
  local plan_file="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}/pipeline-plan.json"
  local strategy="fail"

  local task_plan="$task_dir/pipeline-plan.json"
  if [[ -f "$task_plan" ]]; then
    local s
    s=$(jq -r '.qa_on_timeout // empty' "$task_plan" 2>/dev/null || true)
    [[ -n "$s" ]] && strategy="$s"
  elif [[ -f "$plan_file" ]]; then
    local s
    s=$(jq -r '.qa_on_timeout // empty' "$plan_file" 2>/dev/null || true)
    [[ -n "$s" ]] && strategy="$s"
  fi

  echo "$strategy"
}

# Read qa_reminder_at config (array of percentages like ["50%","90%"]).
# Returns space-separated list of integer percentages. Default: "50 90".
foundry_qa_reminder_at() {
  local task_dir="$1"
  local plan_file="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}/pipeline-plan.json"
  local reminders="50 90"

  local task_plan="$task_dir/pipeline-plan.json"
  local raw=""
  if [[ -f "$task_plan" ]]; then
    raw=$(jq -r '.qa_reminder_at // empty | if type == "array" then .[] else . end' "$task_plan" 2>/dev/null || true)
  elif [[ -f "$plan_file" ]]; then
    raw=$(jq -r '.qa_reminder_at // empty | if type == "array" then .[] else . end' "$plan_file" 2>/dev/null || true)
  fi

  if [[ -n "$raw" ]]; then
    # Strip % signs, collect as space-separated integers
    reminders=$(echo "$raw" | tr -d '%' | tr '\n' ' ' | xargs)
  fi

  echo "$reminders"
}

# Apply the timeout strategy to a waiting_answer task.
# Strategy: fail | skip | fallback
# Returns:
#   0  — pipeline should continue (skip or fallback applied)
#   1  — pipeline should stop (fail strategy)
foundry_qa_apply_timeout_strategy() {
  local task_dir="$1"
  local strategy="${2:-fail}"
  local task_slug="${3:-$(basename "$task_dir")}"

  local qa_file="$task_dir/qa.json"

  case "$strategy" in
    skip)
      # Mark all unanswered questions as skipped
      if [[ -f "$qa_file" ]]; then
        python3 - "$qa_file" <<'PYEOF'
import json, sys
from datetime import datetime, timezone

path = sys.argv[1]
try:
    data = json.loads(open(path).read())
except Exception:
    sys.exit(0)

now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
changed = False
for q in data.get("questions", []):
    if q.get("answer") is None:
        q["answer"] = "__skipped__"
        q["answered_at"] = now
        q["answered_by"] = "system:timeout_skip"
        changed = True

if changed:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=True, indent=2)
        fh.write("\n")
PYEOF
      fi
      # Update state: mark agent as skipped_qa, continue
      foundry_update_state_field "$task_dir" "qa_timeout_action" "skip"
      pipeline_task_append_event "$task_dir" "qa_timeout_skip" \
        "QA timeout: unanswered questions skipped, pipeline continues" ""
      return 0
      ;;

    fallback)
      # Use default_answer from qa.json per-question, or mark as skipped if none
      if [[ -f "$qa_file" ]]; then
        python3 - "$qa_file" <<'PYEOF'
import json, sys
from datetime import datetime, timezone

path = sys.argv[1]
try:
    data = json.loads(open(path).read())
except Exception:
    sys.exit(0)

now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
changed = False
for q in data.get("questions", []):
    if q.get("answer") is None:
        default = q.get("default_answer")
        if default:
            q["answer"] = default
            q["answered_at"] = now
            q["answered_by"] = "system:timeout_fallback"
        else:
            q["answer"] = "__skipped__"
            q["answered_at"] = now
            q["answered_by"] = "system:timeout_skip"
        changed = True

if changed:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=True, indent=2)
        fh.write("\n")
PYEOF
      fi
      foundry_update_state_field "$task_dir" "qa_timeout_action" "fallback"
      pipeline_task_append_event "$task_dir" "qa_timeout_fallback" \
        "QA timeout: default answers applied, pipeline continues" ""
      return 0
      ;;

    fail|*)
      # Default: fail the task
      foundry_update_state_field "$task_dir" "stop_reason" "qa_timeout"
      foundry_set_state_status "$task_dir" "failed" "" ""
      pipeline_task_append_event "$task_dir" "qa_timeout" \
        "QA timeout expired: task failed (strategy=fail)" ""
      return 1
      ;;
  esac
}

# Check if a waiting_answer task has timed out.
# Sends Telegram reminders at configured percentages.
# Applies timeout strategy when expired.
# Returns:
#   0  — not timed out (or no timeout configured)
#   1  — timed out and strategy=fail applied
#   2  — timed out and strategy=skip/fallback applied (pipeline can continue)
foundry_qa_check_timeout() {
  local task_dir="$1"
  local task_slug="${2:-$(basename "$task_dir")}"

  # Only act on waiting_answer tasks
  local status
  status=$(foundry_state_field "$task_dir" status 2>/dev/null || echo "")
  [[ "$status" == "waiting_answer" ]] || return 0

  local waiting_since
  waiting_since=$(foundry_state_field "$task_dir" waiting_since 2>/dev/null || echo "")
  [[ -n "$waiting_since" ]] || return 0

  local timeout_secs
  timeout_secs=$(foundry_qa_timeout_seconds "$task_dir")
  # 0 = no timeout
  [[ "$timeout_secs" -gt 0 ]] 2>/dev/null || return 0

  # Calculate elapsed seconds
  local elapsed_secs
  elapsed_secs=$(python3 - "$waiting_since" <<'PYEOF'
import sys
from datetime import datetime, timezone

raw = sys.argv[1]
try:
    # Handle both Z and +00:00 suffixes
    raw = raw.replace("Z", "+00:00")
    since = datetime.fromisoformat(raw)
    now = datetime.now(timezone.utc)
    print(int((now - since).total_seconds()))
except Exception:
    print(0)
PYEOF
)

  [[ "$elapsed_secs" -gt 0 ]] 2>/dev/null || return 0

  local strategy
  strategy=$(foundry_qa_on_timeout "$task_dir")

  local reminder_percents
  reminder_percents=$(foundry_qa_reminder_at "$task_dir")

  local unanswered
  unanswered=$(foundry_qa_unanswered_count "$task_dir")

  # Check if we should send reminders
  for pct in $reminder_percents; do
    local threshold_secs=$(( timeout_secs * pct / 100 ))
    local reminder_sent_key="qa_reminder_sent_${pct}"
    local already_sent
    already_sent=$(foundry_state_field "$task_dir" "$reminder_sent_key" 2>/dev/null || echo "")

    if [[ "$elapsed_secs" -ge "$threshold_secs" && -z "$already_sent" ]]; then
      # Send reminder
      local elapsed_human
      elapsed_human=$(_foundry_format_duration "$elapsed_secs")
      if [[ -f "${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}/agentic-development/lib/foundry-telegram.sh" ]]; then
        # shellcheck source=/dev/null
        source "${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}/agentic-development/lib/foundry-telegram.sh"
        send_telegram_hitl_timeout_warning "$task_slug" "$elapsed_human" "$unanswered" "$pct"
      fi
      foundry_update_state_field "$task_dir" "$reminder_sent_key" "true"
      pipeline_task_append_event "$task_dir" "qa_reminder" \
        "QA timeout reminder sent at ${pct}% (elapsed: ${elapsed_human})" ""
    fi
  done

  # Check if timeout has expired
  if [[ "$elapsed_secs" -ge "$timeout_secs" ]]; then
    local elapsed_human
    elapsed_human=$(_foundry_format_duration "$elapsed_secs")

    # Send expiry notification
    if [[ -f "${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}/agentic-development/lib/foundry-telegram.sh" ]]; then
      # shellcheck source=/dev/null
      source "${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}/agentic-development/lib/foundry-telegram.sh"
      send_telegram_hitl_timeout_expired "$task_slug" "$strategy"
    fi

    # Apply strategy
    if foundry_qa_apply_timeout_strategy "$task_dir" "$strategy" "$task_slug"; then
      return 2  # skip/fallback: pipeline can continue
    else
      return 1  # fail: pipeline stopped
    fi
  fi

  return 0
}

# Background timeout monitor for waiting_answer tasks.
# Polls all waiting_answer tasks every POLL_INTERVAL seconds.
# Exits when no more waiting tasks remain.
# Args: poll_interval (default 60s)
foundry_qa_timeout_monitor() {
  local poll_interval="${1:-60}"
  local tasks_root="${PIPELINE_TASKS_ROOT:-${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}/tasks}"

  while true; do
    local found_waiting=false
    local task_dir

    for task_dir in "$tasks_root"/*--foundry*/; do
      [[ -d "$task_dir" ]] || continue
      local status
      status=$(foundry_state_field "$task_dir" status 2>/dev/null || echo "")
      [[ "$status" == "waiting_answer" ]] || continue

      found_waiting=true
      local slug
      slug=$(basename "$task_dir")
      slug="${slug%%--foundry*}"

      foundry_qa_check_timeout "$task_dir" "$slug" || true
    done

    # Exit if no waiting tasks remain
    if [[ "$found_waiting" == false ]]; then
      break
    fi

    sleep "$poll_interval"
  done
}

# Mark state.json fields for waiting_answer status.
# Sets: status=waiting_answer, waiting_agent, waiting_since, questions_count, questions_answered.
foundry_set_waiting_answer() {
  local task_dir="$1"
  local waiting_agent="$2"
  local questions_count="${3:-0}"
  foundry_repair_state_file "$task_dir"
  python3 - "$task_dir" "$waiting_agent" "$questions_count" <<'PYEOF'
import json, sys
from datetime import datetime, timezone
from pathlib import Path

task_dir = Path(sys.argv[1])
waiting_agent = sys.argv[2]
questions_count = int(sys.argv[3])
state_path = task_dir / "state.json"

data = {}
if state_path.exists():
    try:
        data = json.loads(state_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
    except (json.JSONDecodeError, OSError):
        data = {}

now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
data["status"] = "waiting_answer"
data["waiting_agent"] = waiting_agent
data["waiting_since"] = now
data["questions_count"] = questions_count
data["questions_answered"] = 0
data["resume_from"] = waiting_agent
data["updated_at"] = now

with open(state_path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=True, indent=2)
    fh.write("\n")
PYEOF
}

# Handle a waiting_answer event from an agent (exit code 75).
#
# Validates qa.json, updates state.json to waiting_answer, checks continue_on_wait
# from pipeline-plan.json, and starts the background timeout monitor.
#
# Returns:
#   0  — continue_on_wait=true (pipeline continues to next agent)
#   75 — pipeline paused (default behavior)
foundry_handle_waiting_answer() {
  local agent="$1"
  local task_dir="$2"

  local qa_file
  qa_file=$(foundry_qa_file "$task_dir")

  # Validate qa.json exists and has unanswered questions
  if [[ ! -f "$qa_file" ]]; then
    echo "  [HITL] Warning: agent ${agent} exited 75 but qa.json not found at ${qa_file}" >&2
    return 75
  fi

  local unanswered
  unanswered=$(foundry_qa_unanswered_count "$task_dir")

  if [[ "$unanswered" -eq 0 ]]; then
    echo "  [HITL] Warning: agent ${agent} exited 75 but no unanswered questions in qa.json" >&2
    return 75
  fi

  # Update state.json to waiting_answer
  foundry_set_waiting_answer "$task_dir" "$agent" "$unanswered"

  # Emit event
  pipeline_task_append_event "$task_dir" "waiting_answer" \
    "Agent ${agent} has ${unanswered} unanswered question(s)" "$agent"

  # Start background timeout monitor (if not already running for this task)
  local monitor_pid_file="$task_dir/.qa_timeout_monitor.pid"
  local already_running=false
  if [[ -f "$monitor_pid_file" ]]; then
    local old_pid
    old_pid=$(cat "$monitor_pid_file" 2>/dev/null || echo "")
    if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
      already_running=true
    fi
  fi

  if [[ "$already_running" == false ]]; then
    # Source self to get access to foundry_qa_check_timeout in subshell
    local _self="${BASH_SOURCE[0]}"
    (
      # shellcheck source=/dev/null
      source "$_self"
      foundry_qa_timeout_monitor 60
    ) &
    local monitor_pid=$!
    echo "$monitor_pid" > "$monitor_pid_file"
  fi

  # Check if profile allows continuing without answers
  local plan_file="${REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}/pipeline-plan.json"
  local task_plan="$task_dir/pipeline-plan.json"
  local continue_on_wait="false"

  if [[ -f "$task_plan" ]]; then
    continue_on_wait=$(jq -r '.continue_on_wait // false' "$task_plan" 2>/dev/null || echo "false")
  elif [[ -f "$plan_file" ]]; then
    continue_on_wait=$(jq -r '.continue_on_wait // false' "$plan_file" 2>/dev/null || echo "false")
  fi

  if [[ "$continue_on_wait" == "true" ]]; then
    # Mark agent for later resume
    foundry_update_state_field "$task_dir" "resume_from" "$agent"
    return 0  # Continue pipeline
  fi

  # Default: pause pipeline
  return 75
}
