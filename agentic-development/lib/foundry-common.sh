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

foundry_list_task_dirs() {
  ensure_pipeline_tasks_root
  find "$PIPELINE_TASKS_ROOT" -maxdepth 1 -type d -name '*--foundry*' | sort
}

foundry_find_tasks_by_status() {
  local wanted="${1:-pending}"
  python3 - "$PIPELINE_TASKS_ROOT" "$wanted" <<'PYEOF'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
wanted = set(sys.argv[2].split(","))
for task_dir in sorted(root.glob("*--foundry*")):
    if not task_dir.is_dir():
        continue
    state_path = task_dir / "state.json"
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
from pathlib import Path

root = Path(sys.argv[1])
counts = Counter()
for task_dir in root.glob("*--foundry*"):
    if not task_dir.is_dir():
        continue
    status = "pending"
    state_path = task_dir / "state.json"
    if state_path.exists():
        try:
            status = json.loads(state_path.read_text(encoding="utf-8")).get("status", "pending")
        except json.JSONDecodeError:
            status = "pending"
    counts[status] += 1
for key in ["pending", "in_progress", "completed", "failed", "suspended", "cancelled"]:
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
  pgrep -f 'agentic-development/lib/foundry-batch\.sh|agentic-development/foundry\.sh headless|foundry-batch\.sh' &>/dev/null
}
