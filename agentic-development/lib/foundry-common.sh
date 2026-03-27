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
  python3 - "$text" <<'PYEOF'
import re
import sys

text = sys.argv[1]
title = ""
for line in text.splitlines():
    stripped = line.strip()
    if stripped.startswith("# "):
        title = stripped[2:].strip()
        break
    if stripped and not stripped.startswith("<!--"):
        title = stripped
        break

if not title:
    title = "unknown"

slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")
print((slug or "unknown")[:60])
PYEOF
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

# ── Debug logging ──────────────────────────────────────────────────
# Enable with FOUNDRY_DEBUG=true in .env.local
if [[ "${FOUNDRY_DEBUG:-}" != "true" && -f "$REPO_ROOT/.env.local" ]]; then
  if grep -qm1 '^FOUNDRY_DEBUG=true' "$REPO_ROOT/.env.local" 2>/dev/null; then
    FOUNDRY_DEBUG=true
  fi
fi
FOUNDRY_DEBUG="${FOUNDRY_DEBUG:-false}"
FOUNDRY_DEBUG_LOG=""

_init_debug_log() {
  if [[ "$FOUNDRY_DEBUG" == "true" && -z "$FOUNDRY_DEBUG_LOG" ]]; then
    ensure_runtime_root
    FOUNDRY_DEBUG_LOG="${RUNTIME_LOG_DIR}/foundry-debug.log"
    debug_log "init" "Debug logging enabled" "pid=$$" "repo=$REPO_ROOT"
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
  python3 - "$event_file" "$event_type" "$message" "$step" <<'PYEOF'
import json
import sys
from datetime import datetime, timezone

path, event_type, message, step = sys.argv[1:5]
event = {
    "timestamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "type": event_type,
}
if message:
    event["message"] = message
if step:
    event["step"] = step

with open(path, "a", encoding="utf-8") as fh:
    fh.write(json.dumps(event, ensure_ascii=True) + "\n")
PYEOF
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
  python3 - "$PIPELINE_TASKS_ROOT" "$path" <<'PYEOF'
from pathlib import Path
import sys

root = Path(sys.argv[1]).resolve()
path = Path(sys.argv[2]).resolve()
for parent in [path] + list(path.parents):
    if parent == root:
        break
    if parent.parent == root and "--foundry" in parent.name:
        print(parent)
        raise SystemExit(0)
raise SystemExit(1)
PYEOF
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
  python3 - "$task_dir" "$task_file" <<'PYEOF'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

task_dir = Path(sys.argv[1])
task_file = Path(sys.argv[2])
state_path = task_dir / "state.json"
meta_path = task_dir / "meta.json"
now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

existing = {}
if state_path.exists():
    try:
        loaded = json.loads(state_path.read_text(encoding="utf-8"))
        if isinstance(loaded, dict):
            existing = loaded
    except (json.JSONDecodeError, OSError, TypeError, ValueError):
        existing = {}

def normalize_str(value):
    return value if isinstance(value, str) and value.strip() else None

def normalize_attempt(value):
    try:
        num = int(value)
    except (TypeError, ValueError):
        return 1
    return num if num >= 1 else 1

payload = {
    "task_id": normalize_str(existing.get("task_id")) or task_dir.name,
    "workflow": "foundry",
    "started_at": normalize_str(existing.get("started_at")) or now,
    "attempt": normalize_attempt(existing.get("attempt")),
    "status": normalize_str(existing.get("status")) or "pending",
    "current_step": normalize_str(existing.get("current_step")),
    "resume_from": normalize_str(existing.get("resume_from")),
    "updated_at": now,
    "task_file": normalize_str(existing.get("task_file")) or str(task_file),
    "branch": normalize_str(existing.get("branch")),
}

if meta_path.exists():
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        if isinstance(meta, dict) and normalize_str(meta.get("branch_name")):
            payload["branch"] = normalize_str(meta.get("branch_name"))
    except (json.JSONDecodeError, OSError, TypeError, ValueError):
        pass

# Preserve agents array if present
agents = existing.get("agents")
if isinstance(agents, list) and agents:
    payload["agents"] = agents

with open(state_path, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, ensure_ascii=True, indent=2)
    fh.write("\n")
PYEOF
}

foundry_write_state() {
  local task_dir="$1"
  local status="$2"
  local current_step="${3:-}"
  local resume_from="${4:-}"
  local task_file="${5:-$task_dir/task.md}"
  foundry_repair_state_file "$task_dir" "$task_file"
  python3 - "$task_dir" "$status" "$current_step" "$resume_from" "$task_file" <<'PYEOF'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

task_dir = Path(sys.argv[1])
status = sys.argv[2]
current_step = sys.argv[3] or None
resume_from = sys.argv[4] or None
task_file = Path(sys.argv[5])
state_path = task_dir / "state.json"
meta_path = task_dir / "meta.json"
payload = {
    "task_id": task_dir.name,
    "workflow": "foundry",
    "status": status,
    "current_step": current_step,
    "resume_from": resume_from,
    "task_file": str(task_file),
    "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
}

if state_path.exists():
    try:
        existing = json.loads(state_path.read_text(encoding="utf-8"))
        if not isinstance(existing, dict):
            existing = {}
    except (json.JSONDecodeError, OSError, TypeError, ValueError):
        existing = {}
    payload["started_at"] = existing.get("started_at") or payload["updated_at"]
    try:
        payload["attempt"] = max(int(existing.get("attempt", 1)), 1)
    except (TypeError, ValueError):
        payload["attempt"] = 1
    if existing.get("branch"):
        payload["branch"] = existing["branch"]
else:
    payload["started_at"] = payload["updated_at"]
    payload["attempt"] = 1

if meta_path.exists():
    try:
      meta = json.loads(meta_path.read_text(encoding="utf-8"))
      if isinstance(meta, dict) and meta.get("branch_name"):
          payload["branch"] = meta["branch_name"]
    except (json.JSONDecodeError, OSError, TypeError, ValueError):
      pass

with open(state_path, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, ensure_ascii=True, indent=2)
    fh.write("\n")
PYEOF
}

foundry_update_state_field() {
  local task_dir="$1"
  local key="$2"
  local value="$3"
  foundry_repair_state_file "$task_dir"
  python3 - "$task_dir" "$key" "$value" <<'PYEOF'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

task_dir = Path(sys.argv[1])
key = sys.argv[2]
value = sys.argv[3]
state_path = task_dir / "state.json"
data = {}
if state_path.exists():
    try:
        data = json.loads(state_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
    except (json.JSONDecodeError, OSError, TypeError, ValueError):
        data = {}
if value == "__NULL__":
    data[key] = None
else:
    data[key] = value
data["updated_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
with open(state_path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=True, indent=2)
    fh.write("\n")
PYEOF
}

foundry_set_state_status() {
  local task_dir="$1"
  local status="$2"
  local current_step="${3:-}"
  local resume_from="${4:-}"
  foundry_repair_state_file "$task_dir"
  python3 - "$task_dir" "$status" "$current_step" "$resume_from" <<'PYEOF'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

task_dir = Path(sys.argv[1])
status = sys.argv[2]
current_step = sys.argv[3] or None
resume_from = sys.argv[4] or None
state_path = task_dir / "state.json"
if state_path.exists():
    try:
        data = json.loads(state_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
    except (json.JSONDecodeError, OSError, TypeError, ValueError):
        data = {}
else:
    data = {
        "task_id": task_dir.name,
        "workflow": "foundry",
        "started_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "attempt": 1,
    }
data["status"] = status
data["current_step"] = current_step
data["resume_from"] = resume_from
data["updated_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
with open(state_path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=True, indent=2)
    fh.write("\n")
PYEOF
}

foundry_increment_attempt() {
  local task_dir="$1"
  foundry_repair_state_file "$task_dir"
  python3 - "$task_dir" <<'PYEOF'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

task_dir = Path(sys.argv[1])
state_path = task_dir / "state.json"
data = {}
if state_path.exists():
    try:
        data = json.loads(state_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
    except (json.JSONDecodeError, OSError, TypeError, ValueError):
        data = {}
data["attempt"] = int(data.get("attempt", 1)) + 1
data["updated_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
with open(state_path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=True, indent=2)
    fh.write("\n")
PYEOF
}

foundry_state_field() {
  local task_dir="$1"
  local key="$2"
  python3 - "$task_dir" "$key" <<'PYEOF'
import json
import sys
from pathlib import Path

task_dir = Path(sys.argv[1])
key = sys.argv[2]
state_path = task_dir / "state.json"
if not state_path.exists():
    raise SystemExit(0)
try:
    data = json.loads(state_path.read_text(encoding="utf-8"))
except json.JSONDecodeError:
    raise SystemExit(0)
value = data.get(key)
if value is None:
    raise SystemExit(0)
print(value)
PYEOF
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
  python3 - "$task_dir" "$agent" "$status" "$model" "$duration_seconds" "$input_tokens" "$output_tokens" "$cost" "$call_count" <<'PYEOF'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

task_dir = Path(sys.argv[1])
agent, status, model = sys.argv[2], sys.argv[3], sys.argv[4]
duration_seconds = sys.argv[5]
input_tokens = sys.argv[6]
output_tokens = sys.argv[7]
cost = sys.argv[8]
call_count = sys.argv[9]

state_path = task_dir / "state.json"
data = {}
if state_path.exists():
    try:
        data = json.loads(state_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
    except (json.JSONDecodeError, OSError):
        data = {}

agents = data.get("agents", [])
if not isinstance(agents, list):
    agents = []

# Find existing agent entry or create new
entry = None
for a in agents:
    if a.get("agent") == agent:
        entry = a
        break
if entry is None:
    entry = {"agent": agent}
    agents.append(entry)

entry["status"] = status

def set_int(key, val):
    if val:
        try:
            entry[key] = int(float(val))
            return
        except (ValueError, TypeError):
            pass
    entry.setdefault(key, "n/d")

def set_float(key, val):
    if val:
        try:
            entry[key] = round(float(val), 4)
            return
        except (ValueError, TypeError):
            pass
    entry.setdefault(key, "n/d")

entry["model"] = model if model else entry.get("model", "n/d")
set_int("duration_seconds", duration_seconds)
set_int("input_tokens", input_tokens)
set_int("output_tokens", output_tokens)
set_float("cost", cost)
set_int("call_count", call_count)

entry["updated_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

data["agents"] = agents
data["updated_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

with open(state_path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=True, indent=2)
    fh.write("\n")
PYEOF
}

# Write all planned agents to state.json as "pending" + set profile
# Called ONCE after planner determines the agent list, before execution starts.
foundry_state_set_planned_agents() {
  local task_dir="$1"
  local profile="$2"
  shift 2
  local agents=("$@")
  foundry_repair_state_file "$task_dir"
  python3 - "$task_dir" "$profile" "${agents[@]}" <<'PYEOF'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

task_dir = Path(sys.argv[1])
profile = sys.argv[2]
planned_agents = sys.argv[3:]

state_path = task_dir / "state.json"
data = {}
if state_path.exists():
    try:
        data = json.loads(state_path.read_text(encoding="utf-8"))
        if not isinstance(data, dict):
            data = {}
    except (json.JSONDecodeError, OSError):
        data = {}

# Preserve existing agent entries (planner may already be "done")
existing = {a["agent"]: a for a in data.get("agents", []) if isinstance(a, dict)}

agents = []
for name in planned_agents:
    if name in existing:
        agents.append(existing[name])
    else:
        agents.append({
            "agent": name,
            "status": "pending",
            "model": "",
            "duration_seconds": 0,
            "input_tokens": 0,
            "output_tokens": 0,
            "cost": 0,
            "call_count": 0,
            "updated_at": ""
        })

data["agents"] = agents
data["profile"] = profile
data["updated_at"] = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

with open(state_path, "w", encoding="utf-8") as fh:
    json.dump(data, fh, ensure_ascii=True, indent=2)
    fh.write("\n")
PYEOF
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
  python3 - "$qa_file" <<'PYEOF'
import json, sys
try:
    data = json.loads(open(sys.argv[1]).read())
    questions = data.get("questions", [])
    count = sum(1 for q in questions if q.get("answer") is None)
    print(count)
except Exception:
    print(0)
PYEOF
}

# Count unanswered BLOCKING questions in qa.json.
# Prints the count (0 if file missing or no blocking questions).
foundry_qa_blocking_unanswered_count() {
  local task_dir="$1"
  local qa_file
  qa_file=$(foundry_qa_file "$task_dir")
  [[ -f "$qa_file" ]] || { echo 0; return; }
  python3 - "$qa_file" <<'PYEOF'
import json, sys
try:
    data = json.loads(open(sys.argv[1]).read())
    questions = data.get("questions", [])
    count = sum(1 for q in questions
                if q.get("priority") == "blocking" and q.get("answer") is None)
    print(count)
except Exception:
    print(0)
PYEOF
}

# Count total questions and answered questions in qa.json.
# Prints "answered/total" (e.g. "1/3").
foundry_qa_progress() {
  local task_dir="$1"
  local qa_file
  qa_file=$(foundry_qa_file "$task_dir")
  [[ -f "$qa_file" ]] || { echo "0/0"; return; }
  python3 - "$qa_file" <<'PYEOF'
import json, sys
try:
    data = json.loads(open(sys.argv[1]).read())
    questions = data.get("questions", [])
    total = len(questions)
    answered = sum(1 for q in questions if q.get("answer") is not None)
    print(f"{answered}/{total}")
except Exception:
    print("0/0")
PYEOF
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
