#!/usr/bin/env bash
# Ultraworks (Sisyphus) Pipeline Monitor
# Shows current state and allows launching OpenCode in tmux

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=/dev/null
source "$PROJECT_ROOT/agentic-development/lib/foundry-common.sh"
PIPELINE_DIR="$PROJECT_ROOT/.opencode/pipeline"
ULTRAWORKS_RUNS_DIR="$PROJECT_ROOT/.opencode/ultraworks/runs"
ULTRAWORKS_WORKTREE_ROOT="$PROJECT_ROOT/.pipeline-worktrees"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m'
ULTRAWORKS_MAX_RUNTIME="${ULTRAWORKS_MAX_RUNTIME:-7200}"
ULTRAWORKS_STALL_TIMEOUT="${ULTRAWORKS_STALL_TIMEOUT:-900}"
ULTRAWORKS_WATCHDOG_INTERVAL="${ULTRAWORKS_WATCHDOG_INTERVAL:-30}"
ULTRAWORKS_AUTO_CLEAN_SUCCESS="${ULTRAWORKS_AUTO_CLEAN_SUCCESS:-0}"

# Debug logging: set ULTRAWORKS_DEBUG=1 or pass --debug to watch
TUI_DEBUG="${ULTRAWORKS_DEBUG:-}"
TUI_DEBUG_LOG=""

_dbg() {
    [[ -n "$TUI_DEBUG" ]] || return 0
    printf '[%s] %s\n' "$(date '+%H:%M:%S.%N' | cut -c1-12)" "$*" >> "$TUI_DEBUG_LOG"
}

_dbg_init() {
    TUI_DEBUG_LOG="$PIPELINE_DIR/logs/tui-debug-$(date +%Y%m%d_%H%M%S).log"
    mkdir -p "$(dirname "$TUI_DEBUG_LOG")"
    _dbg "=== TUI debug start ==="
    _dbg "stdin isatty: $([ -t 0 ] && echo yes || echo no)"
    _dbg "stdout isatty: $([ -t 1 ] && echo yes || echo no)"
    _dbg "tty: $(tty 2>&1 || true)"
    _dbg "/dev/tty: $(ls -la /dev/tty 2>&1 || echo 'not found')"
    _dbg "TERM=$TERM"
    _dbg "shell: $BASH_VERSION"
    _dbg "pid: $$"
    _dbg "ppid: $PPID ($(ps -p $PPID -o comm= 2>/dev/null || echo '?'))"
    echo "Debug log: $TUI_DEBUG_LOG" >&2
}

# Helper functions
print_header() {
    echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
    echo -e "${CYAN}║       Ultraworks (Sisyphus) Pipeline Monitor                 ║${NC}"
    echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
}

print_status() {
    local label="$1"
    local value="$2"
    printf "${BLUE}%-20s${NC} %s\n" "$label:" "$value"
}

_slugify_task() {
    local task_text="${1:-unknown}"
    pipeline_slugify "$task_text"
}

_ensure_runtime_dirs() {
    mkdir -p "$ULTRAWORKS_RUNS_DIR" "$ULTRAWORKS_WORKTREE_ROOT"
}

_metadata_path() {
    local run_id="$1"
    echo "$ULTRAWORKS_RUNS_DIR/${run_id}.env"
}

_task_dir_for_metadata() {
    local metadata_file="${1:-}"
    if [[ -n "$metadata_file" && -f "$metadata_file" ]]; then
        unset TASK_DIR
        _load_run_metadata "$metadata_file" || true
        if [[ -n "${TASK_DIR:-}" ]]; then
            echo "$TASK_DIR"
            return
        fi
    fi
    echo ""
}

_task_file_for_metadata() {
    local metadata_file="${1:-}"
    local filename="$2"
    local task_dir
    task_dir=$(_task_dir_for_metadata "$metadata_file")
    [[ -n "$task_dir" ]] || return 1
    echo "${task_dir}/${filename}"
}

_write_task_meta() {
    local task_dir="$1"
    local workflow="$2"
    local run_id="$3"
    local slug="$4"
    local task_text="$5"
    local branch_name="$6"
    local worktree_path="$7"
    local session_name="$8"
    python3 - "$task_dir/meta.json" "$workflow" "$run_id" "$slug" "$task_text" "$branch_name" "$worktree_path" "$session_name" <<'PYEOF'
import json
import sys
from datetime import datetime, timezone

path, workflow, run_id, slug, task_text, branch_name, worktree_path, session_name = sys.argv[1:9]
payload = {
    "workflow": workflow,
    "run_id": run_id,
    "task_slug": slug,
    "task_text": task_text,
    "branch_name": branch_name,
    "worktree_path": worktree_path,
    "session_name": session_name,
    "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
}
with open(path, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, ensure_ascii=True, indent=2)
    fh.write("\n")
PYEOF
}

_write_task_state() {
    local task_dir="$1"
    local metadata_file="${2:-}"
    local step_override="${3:-}"
    python3 - "$task_dir" "$metadata_file" "$step_override" <<'PYEOF'
import json
import re
import shlex
import sys
from datetime import datetime, timezone
from pathlib import Path

task_dir = Path(sys.argv[1])
metadata_file = Path(sys.argv[2]) if sys.argv[2] else None
step_override = sys.argv[3]
handoff = task_dir / "handoff.md"
state_path = task_dir / "state.json"

env = {}
if metadata_file and metadata_file.exists():
    for raw in metadata_file.read_text(encoding="utf-8").splitlines():
        if "=" not in raw:
            continue
        key, value = raw.split("=", 1)
        try:
            env[key] = shlex.split(value)[0] if value else ""
        except ValueError:
            env[key] = value.strip("'\"")

steps_order = [
    "planner", "investigator", "architect", "coder", "reviewer",
    "auditor", "security-review", "validator", "tester", "e2e",
    "documenter", "translater", "summarizer",
]
status_map = {
    "done": "done",
    "completed": "done",
    "pass": "done",
    "success": "done",
    "failed": "failed",
    "fail": "failed",
    "error": "failed",
    "timeout": "failed",
    "skipped": "skipped",
    "pending": "pending",
    "initialized": "pending",
    "in_progress": "in_progress",
    "in progress": "in_progress",
    "running": "in_progress",
    "rework_requested": "rework_requested",
    "rework requested": "rework_requested",
}

steps = {}
last_seen = None
if handoff.exists():
    current = None
    for raw in handoff.read_text(encoding="utf-8").splitlines():
        m = re.match(r"^##\s+(.+)$", raw)
        if m:
            current = m.group(1).strip().lower()
            steps.setdefault(current, {"id": current, "status": "pending", "attempt": 1})
            last_seen = current
            continue
        if current:
            m = re.search(r"\*\*Status\*\*:\s*(.+)", raw)
            if not m:
                m = re.search(r"- \*\*Status\*\*:\s*(.+)", raw)
            if m:
                raw_status = m.group(1).strip().lower()
                normalized = status_map.get(raw_status, raw_status.replace(" ", "_"))
                steps.setdefault(current, {"id": current, "status": "pending", "attempt": 1})
                steps[current]["status"] = normalized

ordered = []
for step_id in steps_order:
    if step_id in steps:
        ordered.append(steps[step_id])
for step_id, step in steps.items():
    if step_id not in steps_order:
        ordered.append(step)

current_step = step_override or ""
if not current_step:
    for step in ordered:
        if step["status"] in {"in_progress", "rework_requested", "failed"}:
            current_step = step["id"]
            break
if not current_step and last_seen:
    current_step = last_seen

run_status = (env.get("RUN_STATUS") or "").lower()
status = "completed" if run_status == "completed" else "failed" if run_status == "failed" else "in_progress"
if not ordered and status == "in_progress":
    status = "preparing"

payload = {
    "task_id": task_dir.name,
    "workflow": "ultraworks",
    "status": status,
    "current_step": current_step or None,
    "resume_from": current_step or None,
    "updated_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
    "steps": ordered,
}
if state_path.exists():
    try:
        existing = json.loads(state_path.read_text(encoding="utf-8"))
        payload["started_at"] = existing.get("started_at") or payload["updated_at"]
    except json.JSONDecodeError:
        payload["started_at"] = payload["updated_at"]
else:
    payload["started_at"] = payload["updated_at"]

with open(state_path, "w", encoding="utf-8") as fh:
    json.dump(payload, fh, ensure_ascii=True, indent=2)
    fh.write("\n")
PYEOF
}

_link_task_handoff() {
    local worktree_path="$1"
    local task_dir="$2"
    local pipeline_dir="${worktree_path}/.opencode/pipeline"
    mkdir -p "$pipeline_dir"
    rm -f "$pipeline_dir/handoff.md"
    ln -s "$task_dir/handoff.md" "$pipeline_dir/handoff.md"
}

_write_run_metadata() {
    local metadata_file="$1"
    shift
    mkdir -p "$(dirname "$metadata_file")"
    : > "$metadata_file"
    while [[ $# -gt 0 ]]; do
        local key="$1"
        local value="$2"
        shift 2
        printf '%s=%q\n' "$key" "$value" >> "$metadata_file"
    done
}

_update_run_metadata() {
    local metadata_file="$1"
    local key="$2"
    local value="$3"
    mkdir -p "$(dirname "$metadata_file")"
    touch "$metadata_file"
    python3 - "$metadata_file" "$key" "$value" <<'PYEOF'
import shlex
import sys

path, key, value = sys.argv[1:4]
data = {}
with open(path, "r", encoding="utf-8") as fh:
    for raw in fh:
        raw = raw.strip()
        if not raw or "=" not in raw:
            continue
        k, v = raw.split("=", 1)
        try:
            data[k] = shlex.split(v)[0] if v else ""
        except ValueError:
            data[k] = v.strip("'\"")
data[key] = value
with open(path, "w", encoding="utf-8") as fh:
    for k in sorted(data):
        fh.write(f"{k}={shlex.quote(data[k])}\n")
PYEOF
}

_load_run_metadata() {
    local metadata_file="$1"
    [[ -f "$metadata_file" ]] || return 1
    # shellcheck disable=SC1090
    source "$metadata_file"
}

_latest_run_metadata() {
    _ensure_runtime_dirs
    ls -t "$ULTRAWORKS_RUNS_DIR"/*.env 2>/dev/null | head -1 || true
}

_active_run_metadata() {
    _ensure_runtime_dirs
    local latest_active=""
    local latest_mtime=0
    local file
    for file in "$ULTRAWORKS_RUNS_DIR"/*.env; do
        [[ -f "$file" ]] || continue
        unset RUN_STATUS
        _load_run_metadata "$file" || continue
        if [[ "${RUN_STATUS:-}" == "active" ]]; then
            local mtime
            mtime=$(stat -c %Y "$file" 2>/dev/null || echo 0)
            if (( mtime >= latest_mtime )); then
                latest_mtime=$mtime
                latest_active="$file"
            fi
        fi
    done
    echo "$latest_active"
}

_selected_run_metadata() {
    local active
    active=$(_active_run_metadata)
    if [[ -n "$active" ]]; then
        echo "$active"
    else
        _latest_run_metadata
    fi
}

_pipeline_dir_for_metadata() {
    local metadata_file="${1:-}"
    if [[ -n "$metadata_file" && -f "$metadata_file" ]]; then
        unset WORKTREE_PATH
        _load_run_metadata "$metadata_file" || true
        if [[ -n "${WORKTREE_PATH:-}" ]]; then
            echo "${WORKTREE_PATH}/.opencode/pipeline"
            return
        fi
    fi
    echo "$PIPELINE_DIR"
}

_prepare_task_worktree() {
    local run_id="$1"
    local slug="$2"
    local branch_base="pipeline/${slug}"
    local worktree_path="$ULTRAWORKS_WORKTREE_ROOT/ultraworks-${slug}-${run_id}"
    local branch_name="$branch_base"
    local suffix=2

    mkdir -p "$ULTRAWORKS_WORKTREE_ROOT"
    while git -C "$PROJECT_ROOT" show-ref --verify --quiet "refs/heads/${branch_name}" || \
          git -C "$PROJECT_ROOT" show-ref --verify --quiet "refs/remotes/origin/${branch_name}"; do
        branch_name="${branch_base}-${suffix}"
        suffix=$((suffix + 1))
    done

    git -C "$PROJECT_ROOT" worktree add "$worktree_path" -b "$branch_name" HEAD >/dev/null
    echo "${branch_name}|${worktree_path}"
}

_cleanup_task_worktree() {
    local worktree_path="$1"
    [[ -n "$worktree_path" && -d "$worktree_path" ]] || return 0
    git -C "$PROJECT_ROOT" worktree remove --force "$worktree_path" >/dev/null 2>&1 || true
}

get_current_phase() {
    local metadata_file="${1:-}"
    local handoff_file=""
    handoff_file=$(_task_file_for_metadata "$metadata_file" handoff.md 2>/dev/null || true)
    if [[ -z "$handoff_file" || ! -f "$handoff_file" ]]; then
        local pipeline_dir
        pipeline_dir=$(_pipeline_dir_for_metadata "$metadata_file")
        handoff_file="$pipeline_dir/handoff.md"
    fi
    if [[ ! -f "$handoff_file" ]]; then
        echo "idle"
        return
    fi
    
    local last_section
    last_section=$(grep -E "^## " "$handoff_file" | tail -1 | sed 's/^## //')
    if [[ -z "$last_section" ]]; then
        echo "idle"
    else
        echo "$last_section"
    fi
}

get_plan_info() {
    local metadata_file="${1:-}"
    local pipeline_dir
    pipeline_dir=$(_pipeline_dir_for_metadata "$metadata_file")
    if [[ ! -f "$pipeline_dir/plan.json" ]]; then
        echo "{}"
        return
    fi
    cat "$pipeline_dir/plan.json"
}

get_latest_report() {
    local metadata_file="${1:-}"
    local pipeline_dir
    pipeline_dir=$(_pipeline_dir_for_metadata "$metadata_file")
    local latest
    latest=$(ls -t "$pipeline_dir/reports"/*.md 2>/dev/null | head -1)
    if [[ -n "$latest" ]]; then
        echo "$latest"
    fi
}

get_latest_summary() {
    local metadata_file="${1:-}"
    local summary_file=""
    summary_file=$(_task_file_for_metadata "$metadata_file" summary.md 2>/dev/null || true)
    if [[ -n "$summary_file" && -s "$summary_file" ]]; then
        echo "$summary_file"
    fi
}

list_pending_tasks() {
    foundry_find_tasks_by_status "pending" 2>/dev/null | head -10 || true
}

_format_duration() {
    local secs="$1"
    if (( secs >= 3600 )); then
        printf '%dh%02dm' $((secs/3600)) $((secs%3600/60))
    elif (( secs >= 60 )); then
        printf '%dm%02ds' $((secs/60)) $((secs%60))
    else
        printf '%ds' "$secs"
    fi
}

_show_live_status() {
    local metadata_file
    metadata_file=$(_selected_run_metadata)
    local has_tmux=false
    local has_process=false
    local opencode_pid=""
    local session_name=""
    local pipeline_dir
    pipeline_dir=$(_pipeline_dir_for_metadata "$metadata_file")

    if [[ -n "$metadata_file" ]]; then
        unset RUN_PID SESSION_NAME
        _load_run_metadata "$metadata_file" || true
        opencode_pid="${RUN_PID:-}"
        session_name="${SESSION_NAME:-}"
        if [[ -n "$session_name" ]] && command -v tmux &>/dev/null && tmux has-session -t "$session_name" 2>/dev/null; then
            has_tmux=true
        fi
        if [[ -n "$opencode_pid" ]] && kill -0 "$opencode_pid" 2>/dev/null; then
            has_process=true
        fi
    fi

    # 3. Find latest active log (most recent .log in pipeline/logs)
    local log_dir="$pipeline_dir/logs"
    local latest_log=""
    latest_log=$(ls -t "$log_dir"/task-*.log 2>/dev/null | head -1 || true)

    local now; now=$(date +%s)

    if [[ "$has_tmux" == true && "$has_process" == true ]]; then
        # Running — check log health
        local log_health="alive"
        local log_idle=0
        local log_size=0
        local log_mtime=0
        local started_info=""

        if [[ -n "$latest_log" ]]; then
            log_size=$(wc -c < "$latest_log" 2>/dev/null | tr -d ' ')
            log_mtime=$(stat -c %Y "$latest_log" 2>/dev/null || echo "$now")
            log_idle=$(( now - log_mtime ))

            # Estimate start time from log filename: task-YYYYMMDD_HHMMSS-slug.log
            local fname; fname=$(basename "$latest_log" .log)
            if [[ "$fname" =~ task-([0-9]{8}_[0-9]{6})- ]]; then
                local ts="${BASH_REMATCH[1]}"
                local dt="${ts:0:4}-${ts:4:2}-${ts:6:2} ${ts:9:2}:${ts:11:2}:${ts:13:2}"
                local start_epoch
                start_epoch=$(date -d "$dt" +%s 2>/dev/null || echo 0)
                if (( start_epoch > 0 )); then
                    local elapsed=$(( now - start_epoch ))
                    started_info=" elapsed $(_format_duration "$elapsed")"
                fi
            fi

            if (( log_idle > 300 )); then
                log_health="stale"
            elif (( log_idle > 60 )); then
                log_health="idle"
            fi
        fi

        local log_kb=$(( log_size / 1024 ))

        case "$log_health" in
            alive)
                echo -e "${GREEN}  ● RUNNING${NC}  pid=$opencode_pid  log=${log_kb}KB${started_info}"
                ;;
            idle)
                echo -e "${YELLOW}  ◌ RUNNING (idle ${log_idle}s)${NC}  pid=$opencode_pid  log=${log_kb}KB${started_info}"
                ;;
            stale)
                echo -e "${RED}  ⏳ RUNNING (no activity ${log_idle}s)${NC}  pid=$opencode_pid  log=${log_kb}KB${started_info}"
                echo -e "${RED}    Process may be stuck. Check: tmux attach -t ultraworks${NC}"
                ;;
        esac
    elif [[ "$has_tmux" == true && "$has_process" == false ]]; then
        echo -e "${RED}  ✗ DEAD${NC}  tmux session exists but opencode process not found"
        if [[ -n "$session_name" ]]; then
            echo -e "${RED}    Session likely crashed. Kill: tmux kill-session -t ${session_name}${NC}"
        fi
    elif [[ "$has_tmux" == false && "$has_process" == true ]]; then
        echo -e "${YELLOW}  ? DETACHED${NC}  opencode pid=$opencode_pid running without tmux session"
    else
        # Neither tmux nor process — check if there's a recent log that might indicate recent completion
        if [[ -n "$latest_log" ]]; then
            local log_mtime
            log_mtime=$(stat -c %Y "$latest_log" 2>/dev/null || echo 0)
            local age=$(( now - log_mtime ))
            if (( age < 300 )); then
                # Log was active in last 5 min — task probably just finished
                local tail_status="unknown"
                if tail -5 "$latest_log" 2>/dev/null | grep -q "Pipeline finished"; then
                    tail_status="completed"
                elif tail -20 "$latest_log" 2>/dev/null | grep -qi "error\|failed\|exception"; then
                    tail_status="failed"
                fi
                echo -e "${CYAN}  ■ FINISHED${NC}  ($tail_status, ${age}s ago)  $(basename "$latest_log")"
            else
                print_status "Task status" "idle (no active session)"
            fi
        else
            print_status "Task status" "idle (no active session)"
        fi
    fi
    echo ""
}

show_state() {
    local metadata_file
    metadata_file=$(_selected_run_metadata)
    print_header
    echo ""

    print_status "Project root" "$PROJECT_ROOT"
    if [[ -n "$metadata_file" ]]; then
        unset WORKTREE_PATH BRANCH_NAME SESSION_NAME RUN_STATUS TASK_DIR
        _load_run_metadata "$metadata_file" || true
        [[ -n "${SESSION_NAME:-}" ]] && print_status "Session" "$SESSION_NAME"
        [[ -n "${BRANCH_NAME:-}" ]] && print_status "Branch" "$BRANCH_NAME"
        [[ -n "${WORKTREE_PATH:-}" ]] && print_status "Worktree" "$WORKTREE_PATH"
        [[ -n "${TASK_DIR:-}" ]] && print_status "Task dir" "${TASK_DIR#$PROJECT_ROOT/}"
        [[ -n "${RUN_STATUS:-}" ]] && print_status "Run status" "$RUN_STATUS"
        [[ -n "${TASK_DIR:-}" ]] && _write_task_state "$TASK_DIR" "$metadata_file"
    fi

    # ── Live task status ──
    _show_live_status

    # Current phase
    local phase
    phase=$(get_current_phase "$metadata_file")
    print_status "Current phase" "$phase"

    # Plan info
    local pipeline_dir
    pipeline_dir=$(_pipeline_dir_for_metadata "$metadata_file")
    if [[ -f "$pipeline_dir/plan.json" ]]; then
        local profile
        profile=$(jq -r '.profile // "unknown"' "$pipeline_dir/plan.json" 2>/dev/null || echo "unknown")
        local agents
        agents=$(jq -r '.agents | join(", ") // "none"' "$pipeline_dir/plan.json" 2>/dev/null || echo "none")
        print_status "Profile" "$profile"
        print_status "Agents" "$agents"
    fi

    # Latest report
    local latest_report
    latest_report=$(get_latest_report "$metadata_file")
    if [[ -n "$latest_report" ]]; then
        local report_time=$(stat -c %y "$latest_report" 2>/dev/null | cut -d. -f1)
        print_status "Latest report" "$(basename $latest_report) ($report_time)"
    fi

    local latest_summary
    latest_summary=$(get_latest_summary "$metadata_file")
    if [[ -n "$latest_summary" ]]; then
        local summary_time=$(stat -c %y "$latest_summary" 2>/dev/null | cut -d. -f1)
        print_status "Latest summary" "$(basename $latest_summary) ($summary_time)"
    fi

    echo ""
    echo -e "${YELLOW}─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─${NC}"
    echo ""

    # Show handoff state
    local handoff_file=""
    handoff_file=$(_task_file_for_metadata "$metadata_file" handoff.md 2>/dev/null || true)
    if [[ -n "$handoff_file" && -f "$handoff_file" ]]; then
        echo -e "${GREEN}Handoff state:${NC}"
        echo -e "${BLUE}─────────────────${NC}"
        head -40 "$handoff_file"
        echo ""
    elif [[ -f "$pipeline_dir/handoff.md" ]]; then
        echo -e "${GREEN}Handoff state:${NC}"
        echo -e "${BLUE}─────────────────${NC}"
        head -40 "$pipeline_dir/handoff.md"
        echo ""
    fi
    
    # Show pending tasks
    local pending=$(list_pending_tasks)
    if [[ -n "$pending" ]]; then
        echo -e "${YELLOW}Pending Foundry task directories:${NC}"
        echo "$pending" | while read task; do
            local name=$(basename "$task" .md)
            local priority=$(grep -m1 "<!-- priority:" "$task" 2>/dev/null | sed 's/.*priority: *\([0-9]*\).*/\1/' || echo "1")
            echo "  [$priority] $name"
        done
        echo ""
    fi
    
    # Recent reports
    echo -e "${YELLOW}Recent reports:${NC}"
    ls -lt "$pipeline_dir/reports"/*.md 2>/dev/null | head -5 | while read _ _ _ _ _ date time _ file; do
        echo "  $date $time $(basename $file)"
    done || echo "  (no reports)"
}

launch_opencode_tmux() {
    local session_name="ultraworks"
    local task_description="${1:-}"

    # Check if tmux is available
    if ! command -v tmux &> /dev/null; then
        echo -e "${RED}Error: tmux is not installed${NC}"
        echo "Install: sudo apt install tmux"
        return 1
    fi

    # Check if opencode is available
    if ! command -v opencode &> /dev/null; then
        echo -e "${RED}Error: opencode is not installed${NC}"
        return 1
    fi

    # Interactive shell mode keeps a stable session name.
    if [[ -z "$task_description" ]] && tmux has-session -t "$session_name" 2>/dev/null; then
        echo -e "${YELLOW}Session '$session_name' already exists${NC}"
        echo -e "Attach: ${CYAN}tmux attach -t $session_name${NC}"

        # Offer to send task
        if [[ -n "$task_description" ]]; then
            read -p "Send task to existing session? [y/N] " -n1 -r
            echo
            if [[ $REPLY =~ ^[Yy]$ ]]; then
                # Kill existing and relaunch with new task
                tmux kill-session -t "$session_name"
                _launch_opencode_session "$session_name" "$task_description"
            fi
        fi
        return 0
    fi

    _launch_opencode_session "$session_name" "$task_description"
}

_detect_model() {
    # Model routing rules for Sisyphus orchestrator:
    # Both GLM-5 and GPT-5.4 work after builder-agent Sisyphus exception fix.
    # GLM-5 first as primary (free), GPT-5.4 as strong fallback.
    # See: docs/guides/pipeline-models/ for full policy
    local models=(
        "opencode-go/glm-5"
        "openai/gpt-5.4"
        "minimax/MiniMax-M2.7"
        "opencode/big-pickle"
        "google/gemini-3.1-pro-preview"
        "opencode/minimax-m2.5-free"
        "openrouter/free"
        "openrouter/deepseek/deepseek-r1-0528:free"
    )
    local available
    available=$(opencode models 2>/dev/null)

    for model in "${models[@]}"; do
        if echo "$available" | grep -qF "$model"; then
            echo "$model"
            return 0
        fi
    done

    # Fallback to default
    echo ""
    return 1
}

_task_log_path() {
    local timestamp
    timestamp=$(date +%Y%m%d_%H%M%S)
    local task_text="${1:-unknown}"
    local slug
    slug=$(python3 - "$task_text" <<'PYEOF'
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
)
    local log_dir="$PIPELINE_DIR/logs"
    mkdir -p "$log_dir"
    echo "$log_dir/task-${timestamp}-${slug}.log"
}

_create_pr() {
    local repo_dir="${1:-$PROJECT_ROOT}"
    local log_file="${2:-}"
    local branch
    branch=$(git -C "$repo_dir" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")

    if [[ -z "$branch" || "$branch" == "main" || "$branch" == "HEAD" ]]; then
        echo "Skipping PR — not on a feature branch" | tee -a "${log_file:-/dev/null}"
        return 0
    fi

    local pr_title
    pr_title=$(echo "$branch" | sed 's|^pipeline/||' | sed 's/-/ /g' | cut -c1-70)

    # Use latest summary as PR body
    local pr_body="Pipeline completed on branch: $branch"
    local summary_file=""
    local active_metadata
    active_metadata=$(_selected_run_metadata)
    summary_file=$(get_latest_summary "$active_metadata")
    if [[ -n "$summary_file" && -f "$summary_file" ]]; then
        pr_body=$(cat "$summary_file")
    fi

    echo "Creating Pull Request for $branch..." | tee -a "${log_file:-/dev/null}"

    if git -C "$repo_dir" push -u origin "$branch" 2>/dev/null; then
        local pr_url
        pr_url=$(cd "$repo_dir" && gh pr create \
            --base main \
            --head "$branch" \
            --title "[pipeline] ${pr_title}" \
            --body "$pr_body" 2>/dev/null || true)

        if [[ -n "$pr_url" ]]; then
            echo "PR created: $pr_url" | tee -a "${log_file:-/dev/null}"
        else
            echo "PR creation failed (branch pushed)" | tee -a "${log_file:-/dev/null}"
        fi
    else
        echo "Git push failed — PR not created" | tee -a "${log_file:-/dev/null}"
    fi
}

_postprocess_summary_cmd() {
    local start_epoch="$1"
    printf '%q' "./agentic-development/lib/normalize-summary.py"
    printf ' --workflow ultraworks --since-epoch %q || true' "$start_epoch"
}

_timeout_prefix() {
    if command -v timeout &>/dev/null && [[ "$ULTRAWORKS_MAX_RUNTIME" =~ ^[0-9]+$ ]] && (( ULTRAWORKS_MAX_RUNTIME > 0 )); then
        printf 'timeout %q ' "$ULTRAWORKS_MAX_RUNTIME"
    fi
}

_watchdog_marker_path() {
    local log_file="$1"
    echo "${log_file}.watchdog"
}

_start_watchdog() {
    local pipeline_pid="$1"
    local log_file="$2"
    local pipeline_dir="$3"
    local marker_file
    marker_file=$(_watchdog_marker_path "$log_file")

    rm -f "$marker_file"

    if ! [[ "$ULTRAWORKS_STALL_TIMEOUT" =~ ^[0-9]+$ ]] || (( ULTRAWORKS_STALL_TIMEOUT <= 0 )); then
        echo ""
        return 0
    fi

    (
        local last_log_size=0
        local last_log_progress
        local last_handoff_progress
        last_log_progress=$(date +%s)
        last_handoff_progress=$(date +%s)
        local last_handoff_mtime=0

        while kill -0 "$pipeline_pid" 2>/dev/null; do
            sleep "$ULTRAWORKS_WATCHDOG_INTERVAL"

            local now
            now=$(date +%s)
            local log_size=0
            if [[ -f "$log_file" ]]; then
                log_size=$(wc -c < "$log_file" 2>/dev/null || echo 0)
            fi
            if (( log_size > last_log_size )); then
                last_log_size="$log_size"
                last_log_progress="$now"
            fi

            local handoff_mtime=0
            if [[ -f "$pipeline_dir/handoff.md" ]]; then
                handoff_mtime=$(stat -c %Y "$pipeline_dir/handoff.md" 2>/dev/null || echo 0)
            fi
            if (( handoff_mtime > last_handoff_mtime )); then
                last_handoff_mtime="$handoff_mtime"
                last_handoff_progress="$now"
            fi

            local log_idle=$(( now - last_log_progress ))
            local handoff_idle=$(( now - last_handoff_progress ))
            if (( log_idle >= ULTRAWORKS_STALL_TIMEOUT && handoff_idle >= ULTRAWORKS_STALL_TIMEOUT )); then
                printf 'stall:%ss\n' "$ULTRAWORKS_STALL_TIMEOUT" > "$marker_file"
                echo "Ultraworks watchdog: no log or handoff progress for ${ULTRAWORKS_STALL_TIMEOUT}s, terminating pipeline." | tee -a "$log_file"
                kill -TERM "$pipeline_pid" 2>/dev/null || true
                sleep 10
                kill -KILL "$pipeline_pid" 2>/dev/null || true
                exit 0
            fi
        done
    ) &

    echo "$!"
}

_stop_watchdog() {
    local watchdog_pid="${1:-}"
    [[ -z "$watchdog_pid" ]] && return 0
    kill "$watchdog_pid" 2>/dev/null || true
    wait "$watchdog_pid" 2>/dev/null || true
}

_run_headless_pipeline() {
    local task="$1"
    local model="$2"
    local log_file="$3"
    local start_epoch="$4"
    local run_root="$5"
    local metadata_file="$6"
    local pipeline_dir="${run_root}/.opencode/pipeline"
    local task_dir=""
    task_dir=$(_task_dir_for_metadata "$metadata_file")

    local -a run_cmd=(opencode run --command auto "$task")
    if [[ -n "$model" ]]; then
        run_cmd=(opencode run --model "$model" --command auto "$task")
    fi

    local pipeline_pid=""
    if command -v timeout &>/dev/null && [[ "$ULTRAWORKS_MAX_RUNTIME" =~ ^[0-9]+$ ]] && (( ULTRAWORKS_MAX_RUNTIME > 0 )); then
        (
            cd "$run_root"
            timeout "$ULTRAWORKS_MAX_RUNTIME" "${run_cmd[@]}"
        ) > >(tee "$log_file") 2>&1 &
    else
        (
            cd "$run_root"
            "${run_cmd[@]}"
        ) > >(tee "$log_file") 2>&1 &
    fi
    pipeline_pid=$!
    if [[ -n "$metadata_file" ]]; then
        _update_run_metadata "$metadata_file" RUN_PID "$pipeline_pid"
        _update_run_metadata "$metadata_file" RUN_STATUS "active"
    fi
    if [[ -n "$task_dir" ]]; then
        pipeline_task_append_event "$task_dir" "run_started" "Ultraworks run started"
        _write_task_state "$task_dir" "$metadata_file"
    fi

    local watchdog_pid=""
    watchdog_pid=$(_start_watchdog "$pipeline_pid" "$log_file" "$pipeline_dir")

    local pipeline_status=0
    set +e
    wait "$pipeline_pid"
    pipeline_status=$?
    set -e

    _stop_watchdog "$watchdog_pid"

    local marker_file
    marker_file=$(_watchdog_marker_path "$log_file")
    if [[ -f "$marker_file" ]]; then
        echo "Ultraworks pipeline stopped by watchdog ($(cat "$marker_file"))." | tee -a "$log_file"
        [[ -n "$task_dir" ]] && pipeline_task_append_event "$task_dir" "watchdog_stopped" "$(cat "$marker_file")"
        rm -f "$marker_file"
    elif [[ "$pipeline_status" -eq 124 || "$pipeline_status" -eq 137 ]]; then
        echo "Ultraworks wrapper timeout after ${ULTRAWORKS_MAX_RUNTIME}s" | tee -a "$log_file"
        [[ -n "$task_dir" ]] && pipeline_task_append_event "$task_dir" "timeout" "Wrapper timeout after ${ULTRAWORKS_MAX_RUNTIME}s"
    fi

    local task_summary=""
    if [[ -n "$task_dir" ]]; then
        task_summary="${task_dir}/summary.md"
    fi

    local -a postmortem_cmd=(./agentic-development/lib/ultraworks-postmortem-summary.sh)
    local -a normalize_cmd=(./agentic-development/lib/normalize-summary.py --workflow ultraworks --since-epoch "$start_epoch")
    if [[ -n "$task_dir" ]]; then
        postmortem_cmd+=(--handoff "$task_dir/handoff.md")
        normalize_cmd+=(--handoff-file "$task_dir/handoff.md")
        if [[ -n "${task_summary:-}" ]]; then
            postmortem_cmd+=(--summary-file "$task_summary")
            normalize_cmd+=(--summary-file "$task_summary")
        fi
    fi

    (
        cd "$run_root"
        "${postmortem_cmd[@]}"
    ) 2>&1 | tee -a "$log_file" || true
    (
        cd "$run_root"
        "${normalize_cmd[@]}"
    ) 2>&1 | tee -a "$log_file" || true

    # Create PR on success
    if [[ "$pipeline_status" -eq 0 ]]; then
        if [[ -n "$metadata_file" ]]; then
            _update_run_metadata "$metadata_file" RUN_STATUS "completed"
        fi
        [[ -n "$task_dir" ]] && pipeline_task_append_event "$task_dir" "run_completed" "Ultraworks run completed successfully"
        _create_pr "$run_root" "$log_file" || true
        if [[ "$ULTRAWORKS_AUTO_CLEAN_SUCCESS" == "1" && -n "$metadata_file" ]]; then
            unset WORKTREE_PATH
            _load_run_metadata "$metadata_file" || true
            _cleanup_task_worktree "${WORKTREE_PATH:-}"
            _update_run_metadata "$metadata_file" CLEANUP_STATUS "removed"
        elif [[ -n "$metadata_file" ]]; then
            _update_run_metadata "$metadata_file" CLEANUP_STATUS "preserved"
        fi
    elif [[ -n "$metadata_file" ]]; then
        _update_run_metadata "$metadata_file" RUN_STATUS "failed"
        _update_run_metadata "$metadata_file" CLEANUP_STATUS "preserved"
    fi
    if [[ -n "$task_dir" ]]; then
        if [[ "$pipeline_status" -ne 0 ]]; then
            pipeline_task_append_event "$task_dir" "run_failed" "Ultraworks run exited with status $pipeline_status"
        fi
        _write_task_state "$task_dir" "$metadata_file"
    fi

    return "$pipeline_status"
}

_launch_opencode_session() {
    local session_name="$1"
    local task_description="${2:-}"
    local start_epoch
    start_epoch=$(date +%s)

    # Detect best available model for Sisyphus orchestration
    local model
    model=$(_detect_model)
    local model_flag=""
    if [[ -n "$model" ]]; then
        model_flag="--model $model"
        echo -e "${BLUE}Model:${NC} $model"
    fi

    _ensure_runtime_dirs
    echo -e "${GREEN}Starting Sisyphus pipeline in tmux session '$session_name'${NC}"

    if [[ -n "$task_description" ]]; then
        local slug
        slug=$(_slugify_task "$task_description")
        local run_id
        run_id="$(date +%Y%m%d_%H%M%S)"
        local worktree_data
        worktree_data=$(_prepare_task_worktree "$run_id" "$slug")
        local branch_name="${worktree_data%%|*}"
        local worktree_path="${worktree_data#*|}"
        local task_dir
        task_dir=$(pipeline_task_dir_create "$slug" "ultraworks" "$task_description")
        session_name="ultraworks-${slug}-${run_id}"
        # Generate log file path
        local log_file
        log_file="${worktree_path}/.opencode/pipeline/logs/task-${run_id}-${slug}.log"
        mkdir -p "$(dirname "$log_file")"
        _link_task_handoff "$worktree_path" "$task_dir"
        _write_task_meta "$task_dir" "ultraworks" "$run_id" "$slug" "$task_description" "$branch_name" "$worktree_path" "$session_name"
        pipeline_task_append_event "$task_dir" "task_created" "Ultraworks task directory initialized"
        _write_task_state "$task_dir" "" "planner"
        local metadata_file
        metadata_file=$(_metadata_path "$run_id")
        _write_run_metadata "$metadata_file" \
            RUN_ID "$run_id" \
            TASK_SLUG "$slug" \
            TASK_TEXT "$task_description" \
            TASK_DIR "$task_dir" \
            BRANCH_NAME "$branch_name" \
            WORKTREE_PATH "$worktree_path" \
            SESSION_NAME "$session_name" \
            RUN_STATUS "preparing" \
            LOG_FILE "$log_file"
        echo -e "${BLUE}Log:${NC} $log_file"
        echo -e "${BLUE}Branch:${NC} $branch_name"
        echo -e "${BLUE}Worktree:${NC} $worktree_path"
        echo -e "${BLUE}Task dir:${NC} ${task_dir#$PROJECT_ROOT/}"

        local runner
        printf -v runner '%q %q %q %q %q' "$SCRIPT_DIR/ultraworks-monitor.sh" headless --metadata-file "$metadata_file" "$task_description"
        tmux new-session -d -s "$session_name" -c "$worktree_path" \
            "bash -lc '$runner; status=\$?; echo; echo \"Pipeline finished with status \$status. Press Enter to close.\"; read; exit \$status'"
        echo -e "${CYAN}Pipeline running. Attach: tmux attach -t $session_name${NC}"
    else
        # Interactive mode: just start opencode TUI (no logging)
        tmux new-session -d -s "$session_name" -c "$PROJECT_ROOT" \
            "opencode $model_flag"
        echo -e "${CYAN}OpenCode TUI started. Attach: tmux attach -t $session_name${NC}"
    fi
}

interactive_menu() {
    while true; do
        echo ""
        echo -e "${CYAN}Actions:${NC}"
        echo "  1) Show current state"
        echo "  2) Launch OpenCode (tmux)"
        echo "  3) View latest report"
        echo "  4) View latest summary"
        echo "  5) View handoff"
        echo "  6) Tail logs"
        echo "  q) Quit"
        echo ""
        read -p "Choose [1-6/q]: " -n1 -r
        echo ""
        
        case $REPLY in
            1) show_state ;;
            2) launch_opencode_tmux ;;
            3) 
                local report=$(get_latest_report)
                if [[ -n "$report" ]]; then
                    less "$report"
                else
                    echo -e "${YELLOW}No reports available${NC}"
                fi
                ;;
            4)
                local summary
                summary=$(get_latest_summary "$metadata_file")
                if [[ -n "$summary" ]]; then
                    less "$summary"
                else
                    echo -e "${YELLOW}No summary available${NC}"
                fi
                ;;
            5)
                local metadata_file
                metadata_file=$(_selected_run_metadata)
                local handoff_file
                handoff_file=$(_task_file_for_metadata "$metadata_file" handoff.md 2>/dev/null || true)
                if [[ -n "$handoff_file" && -f "$handoff_file" ]]; then
                    less "$handoff_file"
                elif [[ -f "$(_pipeline_dir_for_metadata "$metadata_file")/handoff.md" ]]; then
                    less "$(_pipeline_dir_for_metadata "$metadata_file")/handoff.md"
                else
                    echo -e "${YELLOW}No handoff available${NC}"
                fi
                ;;
            6)
                local metadata_file
                metadata_file=$(_selected_run_metadata)
                local pipeline_dir
                pipeline_dir=$(_pipeline_dir_for_metadata "$metadata_file")
                local log_dir="$pipeline_dir/logs"
                if [[ -d "$log_dir" ]]; then
                    ls -lt "$log_dir"/*.log 2>/dev/null | head -1 | awk '{print $NF}' | xargs tail -f || echo "No logs"
                else
                    echo -e "${YELLOW}No logs available${NC}"
                fi
                ;;
            q|Q) exit 0 ;;
            *) echo -e "${RED}Invalid option${NC}" ;;
        esac
    done
}

# ═══════════════════════════════════════════════════════════════════════
# TUI Watch Mode — split-panel live monitor
# Left 2/3: main content (task info, handoff, logs)
# Right 1/3: agent progress sidebar
# ═══════════════════════════════════════════════════════════════════════

_tui_term_size() {
    TUI_ROWS=$(tput lines 2>/dev/null || echo 24)
    TUI_COLS=$(tput cols 2>/dev/null || echo 80)
}

# Parse agent list from plan.json
_tui_get_agents() {
    local metadata_file
    metadata_file=$(_selected_run_metadata)
    local pipeline_dir
    pipeline_dir=$(_pipeline_dir_for_metadata "$metadata_file")
    if [[ -f "$pipeline_dir/plan.json" ]]; then
        jq -r '.agents[]' "$pipeline_dir/plan.json" 2>/dev/null
    fi
}

# Parse agent statuses from handoff.md
# Returns: agent_name|status lines
_tui_get_agent_statuses() {
    local handoff="$1"
    [[ -f "$handoff" ]] || return
    local current_agent=""
    while IFS= read -r line; do
        if [[ "$line" =~ ^##[[:space:]]+(.+)$ ]]; then
            current_agent="${BASH_REMATCH[1]}"
            # Normalize to lowercase
            current_agent=$(echo "$current_agent" | tr '[:upper:]' '[:lower:]')
        elif [[ -n "$current_agent" && "$line" =~ \*\*Status\*\*:[[:space:]]*(.+) ]]; then
            local status="${BASH_REMATCH[1]}"
            echo "${current_agent}|${status}"
            current_agent=""
        fi
    done < "$handoff"
}

# Find the active handoff file (most recent handoff-*.md or handoff.md)
_tui_find_handoff() {
    local metadata_file
    metadata_file=$(_selected_run_metadata)
    local task_handoff
    task_handoff=$(_task_file_for_metadata "$metadata_file" handoff.md 2>/dev/null || true)
    if [[ -n "$task_handoff" && -f "$task_handoff" ]]; then
        echo "$task_handoff"
        return
    fi
    local pipeline_dir
    pipeline_dir=$(_pipeline_dir_for_metadata "$metadata_file")
    [[ -f "$pipeline_dir/handoff.md" ]] && echo "$pipeline_dir/handoff.md"
}

# Render right sidebar content into SIDEBAR_LINES array
_tui_build_sidebar() {
    SIDEBAR_LINES=()
    local sidebar_w="$1"
    local inner_w=$((sidebar_w - 3))  # padding + border

    # Decide mode: active task → agent checklist, idle → summaries
    local has_tmux=false has_process=false
    local metadata_file
    metadata_file=$(_selected_run_metadata)
    if [[ -n "$metadata_file" ]]; then
        unset SESSION_NAME RUN_PID
        _load_run_metadata "$metadata_file" || true
        if [[ -n "${SESSION_NAME:-}" ]] && command -v tmux &>/dev/null && tmux has-session -t "$SESSION_NAME" 2>/dev/null; then has_tmux=true; fi
        if [[ -n "${RUN_PID:-}" ]] && kill -0 "${RUN_PID}" 2>/dev/null; then has_process=true; fi
    fi

    if [[ "$has_tmux" == true || "$has_process" == true ]]; then
        _tui_build_sidebar_agents "$sidebar_w" "$has_process"
    else
        _tui_build_sidebar_summaries "$sidebar_w"
    fi
}

# Sidebar: agent checklist (when task is active)
_tui_build_sidebar_agents() {
    local sidebar_w="$1"
    local has_process="$2"
    local inner_w=$((sidebar_w - 3))

    # Header
    SIDEBAR_LINES+=("$(printf " ${CYAN}%-${inner_w}s${NC}" "Agents")")
    SIDEBAR_LINES+=("$(printf " ${CYAN}%s${NC}" "$(printf '%*s' "$inner_w" '' | tr ' ' '─')")")

    # Get agents and their statuses
    local -A agent_status
    local handoff
    handoff=$(_tui_find_handoff)
    if [[ -n "$handoff" ]]; then
        while IFS='|' read -r name status; do
            agent_status["$name"]="$status"
        done < <(_tui_get_agent_statuses "$handoff")
    fi

    local agents=()
    while IFS= read -r a; do
        [[ -n "$a" ]] && agents+=("$a")
    done < <(_tui_get_agents)

    if [[ ${#agents[@]} -eq 0 ]]; then
        SIDEBAR_LINES+=("$(printf " ${NC}%-${inner_w}s${NC}" "(no plan)")")
        _tui_build_sidebar_status "$inner_w"
        return
    fi

    local now; now=$(date +%s)
    local spin_chars='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
    local spin_idx=$(( now % 10 ))
    local spinner="${spin_chars:$spin_idx:1}"

    # Pipeline is sequential: find the last completed/failed agent index.
    # All agents before it are implicitly done (even if handoff says "pending").
    local last_done_idx=-1
    local idx=0
    for agent in "${agents[@]}"; do
        local st="${agent_status[$agent]:-pending}"
        case "$st" in
            completed|done|failed|error|skipped) last_done_idx=$idx ;;
        esac
        idx=$((idx + 1))
    done

    local found_running=false
    idx=0
    for agent in "${agents[@]}"; do
        local st="${agent_status[$agent]:-pending}"
        local icon label color
        local agent_display="$agent"
        # Capitalize first letter for display
        agent_display="$(echo "${agent:0:1}" | tr '[:lower:]' '[:upper:]')${agent:1}"

        case "$st" in
            completed|done)
                icon="✓"
                color="$GREEN"
                label="done"
                ;;
            failed|error)
                icon="✗"
                color="$RED"
                label="fail"
                ;;
            skipped)
                icon="–"
                color="$YELLOW"
                label="skip"
                ;;
            *)
                if (( idx < last_done_idx )); then
                    # Before the last completed agent — implicitly done
                    icon="✓"
                    color="$GREEN"
                    label="done"
                elif [[ "$found_running" == false && "$has_process" == true ]]; then
                    # First non-completed agent while process is running = active
                    icon="$spinner"
                    color="$YELLOW"
                    label="running"
                    found_running=true
                else
                    icon="○"
                    color="$NC"
                    label=""
                fi
                ;;
        esac

        local line
        if [[ -n "$label" ]]; then
            line=$(printf " %b%s%b %-*s %b%s%b" "$color" "$icon" "$NC" $((inner_w - 10)) "$agent_display" "$color" "$label" "$NC")
        else
            line=$(printf " %b%s%b %-*s" "$color" "$icon" "$NC" $((inner_w - 3)) "$agent_display")
        fi
        SIDEBAR_LINES+=("$line")
        idx=$((idx + 1))
    done

    # Task elapsed time at bottom
    SIDEBAR_LINES+=("$(printf " ${CYAN}%s${NC}" "$(printf '%*s' "$inner_w" '' | tr ' ' '─')")")
    if [[ -n "$handoff" ]]; then
        local started_str
        started_str=$(grep -oP '(?<=\*\*Started\*\*: ).*' "$handoff" 2>/dev/null | head -1)
        if [[ -n "$started_str" ]]; then
            local started_epoch
            started_epoch=$(date -d "$started_str" +%s 2>/dev/null || echo 0)
            if (( started_epoch > 0 )); then
                local elapsed=$(( now - started_epoch ))
                SIDEBAR_LINES+=("$(printf " %-${inner_w}s" "⏱ $(_format_duration "$elapsed")")")
            fi
        fi
        local task_name
        task_name=$(grep -oP '(?<=\*\*Task\*\*: ).*' "$handoff" 2>/dev/null | head -1)
        if [[ -n "$task_name" ]]; then
            if (( ${#task_name} > inner_w - 1 )); then
                task_name="${task_name:0:$((inner_w - 4))}..."
            fi
            SIDEBAR_LINES+=("$(printf " ${NC}%-${inner_w}s${NC}" "$task_name")")
        fi
    fi

    # Live status indicator
    _tui_build_sidebar_status "$inner_w"
}

# Sidebar: recent summaries (when idle)
_tui_build_sidebar_summaries() {
    local sidebar_w="$1"
    local inner_w=$((sidebar_w - 3))

    SIDEBAR_LINES+=("$(printf " ${CYAN}%-${inner_w}s${NC}" "Recent Runs")")
    SIDEBAR_LINES+=("$(printf " ${CYAN}%s${NC}" "$(printf '%*s' "$inner_w" '' | tr ' ' '─')")")

    # Collect task-local summaries from tasks/*--ultraworks/summary.md
    local -a entries=()

    local f
    for f in $(find "$PIPELINE_TASKS_ROOT" -maxdepth 2 -type f -path '*--ultraworks/summary.md' 2>/dev/null | head -20); do
        [[ -s "$f" ]] || continue
        local task_dir; task_dir=$(dirname "$f")
        local name; name=$(basename "$task_dir")
        local mtime; mtime=$(stat -c %Y "$f" 2>/dev/null || echo 0)
        local status="—"
        local st_line
        st_line=$(grep -m1 '^\*\*Статус:\*\*\|^\*\*Status:\*\*' "$f" 2>/dev/null || true)
        if echo "$st_line" | grep -qi "pass\|done\|success"; then
            status="PASS"
        elif echo "$st_line" | grep -qi "fail"; then
            status="FAIL"
        fi
        # Extract workflow
        local workflow="—"
        local wf_line
        wf_line=$(grep -m1 '^\*\*Workflow:\*\*' "$f" 2>/dev/null || true)
        if [[ -n "$wf_line" ]]; then
            workflow=$(echo "$wf_line" | sed 's/.*\*\*Workflow:\*\* *//')
        fi
        entries+=("${mtime}|summary|${status}|${workflow}|${name}|${f}")
    done

    if [[ ${#entries[@]} -eq 0 ]]; then
        SIDEBAR_LINES+=("$(printf " ${NC}%-${inner_w}s${NC}" "(no history)")")
        SIDEBAR_LINES+=("")
        SIDEBAR_LINES+=("$(printf " ${NC}%-${inner_w}s${NC}" "○ idle")")
        return
    fi

    # Sort by mtime descending, take top entries that fit
    local sorted
    sorted=$(printf '%s\n' "${entries[@]}" | sort -t'|' -k1 -rn | head -15)

    local now; now=$(date +%s)
    local count=0
    while IFS='|' read -r mtime etype estatus einfo ename epath; do
        [[ -z "$mtime" ]] && continue

        # Age
        local age=$(( now - mtime ))
        local age_str
        if (( age < 3600 )); then
            age_str="$((age / 60))m"
        elif (( age < 86400 )); then
            age_str="$((age / 3600))h"
        else
            age_str="$((age / 86400))d"
        fi

        # Status icon
        local icon color
        case "$estatus" in
            PASS) icon="✓"; color="$GREEN" ;;
            FAIL) icon="✗"; color="$RED" ;;
            *)    icon="·"; color="$NC" ;;
        esac

        # Truncate name for display
        local display_name="$ename"
        local max_name=$((inner_w - 8))  # icon + age + spaces
        if (( ${#display_name} > max_name )); then
            display_name="${display_name:0:$((max_name - 2))}.."
        fi

        SIDEBAR_LINES+=("$(printf " %b%s%b %-${max_name}s %b%3s%b" "$color" "$icon" "$NC" "$display_name" "$NC" "$age_str" "$NC")")
        count=$((count + 1))
    done <<< "$sorted"

    # Footer
    SIDEBAR_LINES+=("$(printf " ${CYAN}%s${NC}" "$(printf '%*s' "$inner_w" '' | tr ' ' '─')")")
    SIDEBAR_LINES+=("$(printf " ${NC}%-${inner_w}s${NC}" "○ idle — $count runs")")
}

_tui_build_sidebar_status() {
    local inner_w="$1"
    local has_tmux=false
    local has_process=false
    local metadata_file
    metadata_file=$(_selected_run_metadata)

    if [[ -n "$metadata_file" ]]; then
        unset SESSION_NAME RUN_PID
        _load_run_metadata "$metadata_file" || true
        if [[ -n "${SESSION_NAME:-}" ]] && command -v tmux &>/dev/null && tmux has-session -t "$SESSION_NAME" 2>/dev/null; then
            has_tmux=true
        fi
        if [[ -n "${RUN_PID:-}" ]] && kill -0 "${RUN_PID}" 2>/dev/null; then
            has_process=true
        fi
    fi

    if [[ "$has_tmux" == true && "$has_process" == true ]]; then
        SIDEBAR_LINES+=("$(printf " ${GREEN}● live${NC}%*s" $((inner_w - 6)) "")")
    elif [[ "$has_tmux" == true ]]; then
        SIDEBAR_LINES+=("$(printf " ${RED}✗ dead${NC}%*s" $((inner_w - 6)) "")")
    elif [[ "$has_process" == true ]]; then
        SIDEBAR_LINES+=("$(printf " ${YELLOW}? detached${NC}%*s" $((inner_w - 10)) "")")
    else
        SIDEBAR_LINES+=("$(printf " ${NC}○ idle${NC}%*s" $((inner_w - 6)) "")")
    fi
}

# Build left-panel content into LEFT_LINES array
_tui_build_left() {
    LEFT_LINES=()
    local left_w="$1"

    # Live status line
    local has_tmux=false has_process=false opencode_pid=""
    local metadata_file
    metadata_file=$(_selected_run_metadata)
    local pipeline_dir
    pipeline_dir=$(_pipeline_dir_for_metadata "$metadata_file")
    if [[ -n "$metadata_file" ]]; then
        unset SESSION_NAME RUN_PID
        _load_run_metadata "$metadata_file" || true
        if [[ -n "${SESSION_NAME:-}" ]] && command -v tmux &>/dev/null && tmux has-session -t "$SESSION_NAME" 2>/dev/null; then has_tmux=true; fi
        opencode_pid="${RUN_PID:-}"
        if [[ -n "$opencode_pid" ]] && kill -0 "$opencode_pid" 2>/dev/null; then
            has_process=true
        fi
    fi

    local now; now=$(date +%s)

    # Status header
    if [[ "$has_tmux" == true && "$has_process" == true ]]; then
        local log_info=""
        local latest_log
        latest_log=$(ls -t "$pipeline_dir/logs"/task-*.log 2>/dev/null | head -1 || true)
        if [[ -n "$latest_log" ]]; then
            local log_size log_mtime log_idle
            log_size=$(wc -c < "$latest_log" 2>/dev/null | tr -d ' ')
            log_mtime=$(stat -c %Y "$latest_log" 2>/dev/null || echo "$now")
            log_idle=$(( now - log_mtime ))
            local log_kb=$(( log_size / 1024 ))
            if (( log_idle > 300 )); then
                log_info="  ${RED}no activity ${log_idle}s${NC}"
            elif (( log_idle > 60 )); then
                log_info="  ${YELLOW}idle ${log_idle}s${NC}"
            fi
            LEFT_LINES+=("$(printf "  ${GREEN}● RUNNING${NC}  pid=%s  log=%sKB%b" "$opencode_pid" "$log_kb" "$log_info")")
        else
            LEFT_LINES+=("$(printf "  ${GREEN}● RUNNING${NC}  pid=%s" "$opencode_pid")")
        fi
    elif [[ "$has_tmux" == true ]]; then
        LEFT_LINES+=("$(printf "  ${RED}✗ DEAD${NC}  tmux exists, opencode not found")")
    elif [[ "$has_process" == true ]]; then
        LEFT_LINES+=("$(printf "  ${YELLOW}? DETACHED${NC}  pid=%s, no tmux" "$opencode_pid")")
    else
        LEFT_LINES+=("$(printf "  ${NC}○ IDLE${NC}  no active session")")
    fi
    LEFT_LINES+=("")

    # Phase info
    local phase; phase=$(get_current_phase)
    LEFT_LINES+=("$(printf "  Phase: ${CYAN}%s${NC}" "$phase")")

    # Plan profile
    if [[ -f "$pipeline_dir/plan.json" ]]; then
        local profile; profile=$(jq -r '.profile // "?"' "$pipeline_dir/plan.json" 2>/dev/null)
        LEFT_LINES+=("$(printf "  Profile: %s" "$profile")")
    fi
    LEFT_LINES+=("")

    # Handoff content (main body)
    local handoff
    handoff=$(_tui_find_handoff)
    if [[ -n "$handoff" ]]; then
        LEFT_LINES+=("$(printf "  ${GREEN}Handoff:${NC}")")
        LEFT_LINES+=("$(printf "  ${BLUE}%s${NC}" "$(printf '%*s' $((left_w - 4)) '' | tr ' ' '─')")")
        while IFS= read -r line; do
            # Truncate long lines
            if (( ${#line} > left_w - 4 )); then
                line="${line:0:$((left_w - 7))}..."
            fi
            LEFT_LINES+=("  $line")
        done < <(head -50 "$handoff")
    else
        LEFT_LINES+=("  (no handoff)")
    fi

    LEFT_LINES+=("")

    # Pending tasks
    local pending; pending=$(list_pending_tasks)
    if [[ -n "$pending" ]]; then
        LEFT_LINES+=("$(printf "  ${YELLOW}Pending tasks:${NC}")")
        while IFS= read -r task_file; do
            [[ -z "$task_file" ]] && continue
            local name; name=$(basename "$task_file" .md)
            LEFT_LINES+=("    $name")
        done <<< "$pending"
    fi
}

# Merge left and right panels line-by-line
_tui_render_frame() {
    _tui_term_size
    local sidebar_w=$((TUI_COLS / 3))
    [[ "$sidebar_w" -lt 20 ]] && sidebar_w=20
    [[ "$sidebar_w" -gt 40 ]] && sidebar_w=40
    local left_w=$((TUI_COLS - sidebar_w - 1))  # -1 for border

    _tui_build_left "$left_w"
    _tui_build_sidebar "$sidebar_w"

    # Available content rows (minus header 2 + footer 2)
    local avail=$((TUI_ROWS - 4))
    [[ "$avail" -lt 5 ]] && avail=5

    # Clamp scroll offset
    local left_total=${#LEFT_LINES[@]}
    local max_scroll=$(( left_total - avail ))
    [[ "$max_scroll" -lt 0 ]] && max_scroll=0
    [[ "$TUI_SCROLL" -gt "$max_scroll" ]] && TUI_SCROLL=$max_scroll
    [[ "$TUI_SCROLL" -lt 0 ]] && TUI_SCROLL=0

    local scrollable=false
    [[ "$left_total" -gt "$avail" ]] && scrollable=true

    # Scroll indicator
    local scroll_hint=""
    if [[ "$scrollable" == true ]]; then
        if [[ "$TUI_SCROLL" -gt 0 && "$TUI_SCROLL" -lt "$max_scroll" ]]; then
            scroll_hint="  ↑↓ scroll"
        elif [[ "$TUI_SCROLL" -eq 0 ]]; then
            scroll_hint="  ↓ more"
        else
            scroll_hint="  ↑ back"
        fi
    fi

    # Header
    printf '\033[H'  # cursor home
    printf '\033[2K'
    printf "  ${CYAN}Ultraworks Monitor${NC}  %s  ${CYAN}q${NC}=quit%b\n" "$(date '+%H:%M:%S')" "$scroll_hint"
    printf '\033[2K'
    printf "${CYAN}%s${NC}\n" "$(printf '%*s' "$TUI_COLS" '' | tr ' ' '─')"

    local i
    for (( i = 0; i < avail; i++ )); do
        local left_idx=$(( i + TUI_SCROLL ))
        local left_line="${LEFT_LINES[$left_idx]:-}"
        local right_line="${SIDEBAR_LINES[$i]:-}"

        # Strip ANSI for width calculation
        local left_visible
        left_visible=$(printf '%b' "$left_line" | sed 's/\x1b\[[0-9;]*m//g')
        local left_len=${#left_visible}
        local pad=$((left_w - left_len))
        [[ "$pad" -lt 0 ]] && pad=0

        printf '\033[2K'  # clear line
        printf '%b%*s│%b\n' "$left_line" "$pad" "" "$right_line"
    done

    # Footer
    printf '\033[2K'
    printf "${CYAN}%s${NC}\n" "$(printf '%*s' "$TUI_COLS" '' | tr ' ' '─')"
    printf '\033[2K'
    printf "  ${NC}[q] quit  [a] attach  [l] logs  [j/k] scroll  [g/G] top/end${NC}\n"
}

# Read a single key or escape sequence from stdin (non-blocking).
# Sets TUI_KEY to the key/sequence, or "" if nothing available.
_tui_read_key() {
    TUI_KEY=""
    local ch
    ch=$(dd bs=1 count=1 2>/dev/null || true)
    [[ -z "$ch" ]] && return
    if [[ "$ch" == $'\033' ]]; then
        # Possible escape sequence — read up to 5 more bytes quickly
        local seq=""
        local i
        for i in 1 2 3 4 5; do
            local next
            next=$(dd bs=1 count=1 2>/dev/null || true)
            [[ -z "$next" ]] && break
            seq+="$next"
            # Standard CSI sequences end at a letter
            if [[ "$next" =~ [A-Za-z~] ]]; then break; fi
        done
        TUI_KEY="${ch}${seq}"
    else
        TUI_KEY="$ch"
    fi
}

# Drain all pending input, accumulate scroll delta and detect action keys.
# Sets: TUI_ACTION (key action to take) and TUI_SCROLL_DELTA (accumulated scroll)
_tui_drain_input() {
    TUI_ACTION=""
    TUI_SCROLL_DELTA=0
    local got_input=false

    while true; do
        _tui_read_key
        [[ -z "$TUI_KEY" ]] && break
        got_input=true

        case "$TUI_KEY" in
            q|Q)          TUI_ACTION="quit"; return ;;
            a|A)          TUI_ACTION="attach"; return ;;
            l|L)          TUI_ACTION="logs"; return ;;
            g)            TUI_ACTION="top"; return ;;
            G)            TUI_ACTION="bottom"; return ;;
            # Arrow up / k — accumulate scroll up
            $'\033[A'|k|K)
                TUI_SCROLL_DELTA=$((TUI_SCROLL_DELTA - 1))
                ;;
            # Arrow down / j — accumulate scroll down
            $'\033[B'|j|J)
                TUI_SCROLL_DELTA=$((TUI_SCROLL_DELTA + 1))
                ;;
            # Mouse wheel up (SGR encoding: ESC[<65;...M or legacy ESC[Ma...)
            $'\033[<65'*|$'\033[Ma'*)
                TUI_SCROLL_DELTA=$((TUI_SCROLL_DELTA - 1))
                ;;
            # Mouse wheel down
            $'\033[<64'*|$'\033[M`'*)
                TUI_SCROLL_DELTA=$((TUI_SCROLL_DELTA + 1))
                ;;
        esac
    done

    [[ "$got_input" == true ]] && TUI_ACTION="scroll"
}

_tui_watch() {
    local refresh="${1:-3}"
    TUI_SCROLL=0  # Left panel scroll offset
    local last_render=0

    # TUI loop must not use set -e — arithmetic, dd, and stty can return
    # non-zero in normal operation which would kill the script.
    set +e

    # Init debug logging if enabled
    [[ -n "$TUI_DEBUG" ]] && _dbg_init

    # Ensure stdin is a tty. Makefile passes `< /dev/tty`.
    # When run directly without tty, just auto-refresh without key input.
    if [[ -t 0 ]]; then
        _dbg "stdin is tty, setting raw mode"
        stty -echo -icanon min 0 time 0 2>/dev/null || true
        _dbg "stty result: $?"
    else
        _dbg "stdin is NOT tty — keys disabled, auto-refresh only"
    fi

    # Enter alternate screen, hide cursor
    printf '\033[?1049h'
    tput civis 2>/dev/null || true
    _dbg "alternate screen entered"

    # Restore on exit
    trap '_tui_cleanup' EXIT INT TERM

    _dbg "entering main loop, refresh=${refresh}s"
    local frame_n=0
    while true; do
        frame_n=$((frame_n + 1))
        _dbg "frame #${frame_n} render start"
        _tui_render_frame
        last_render=$(date +%s)
        _dbg "frame #${frame_n} rendered, waiting for input"

        # Wait for input with timeout, using debounce
        local deadline=$((last_render + refresh))
        TUI_ACTION=""

        while true; do
            local now
            now=$(date +%s)
            if [[ "$now" -ge "$deadline" ]]; then break; fi

            # Drain all pending input at once (debounce)
            _tui_drain_input

            if [[ -n "$TUI_ACTION" ]]; then
                _dbg "action: $TUI_ACTION scroll_delta=$TUI_SCROLL_DELTA"
                break
            fi
            sleep 0.15
        done

        # Apply accumulated scroll delta (clamped)
        if [[ "$TUI_SCROLL_DELTA" -ne 0 ]]; then
            TUI_SCROLL=$((TUI_SCROLL + TUI_SCROLL_DELTA * 2))
            [[ "$TUI_SCROLL" -lt 0 ]] && TUI_SCROLL=0
            local max_scroll=$(( ${#LEFT_LINES[@]} - (TUI_ROWS - 5) ))
            [[ "$max_scroll" -lt 0 ]] && max_scroll=0
            [[ "$TUI_SCROLL" -gt "$max_scroll" ]] && TUI_SCROLL=$max_scroll
        fi

        case "$TUI_ACTION" in
            quit)
                return 0
                ;;
            top)
                TUI_SCROLL=0
                ;;
            bottom)
                local max_scroll=$(( ${#LEFT_LINES[@]} - (TUI_ROWS - 5) ))
                [[ "$max_scroll" -lt 0 ]] && max_scroll=0
                TUI_SCROLL=$max_scroll
                ;;
            attach)
                _tui_cleanup_soft
                local selected_metadata
                selected_metadata=$(_selected_run_metadata)
                local selected_session="ultraworks"
                if [[ -n "$selected_metadata" ]]; then
                    unset SESSION_NAME
                    _load_run_metadata "$selected_metadata" || true
                    [[ -n "${SESSION_NAME:-}" ]] && selected_session="$SESSION_NAME"
                fi
                tmux attach -t "$selected_session" 2>/dev/null || echo "No ultraworks session"
                _tui_reenter
                ;;
            logs)
                _tui_cleanup_soft
                local selected_metadata
                selected_metadata=$(_selected_run_metadata)
                local pipeline_dir
                pipeline_dir=$(_pipeline_dir_for_metadata "$selected_metadata")
                local log_dir="$pipeline_dir/logs"
                local latest
                latest=$(ls -t "$log_dir"/task-*.log 2>/dev/null | head -1 || true)
                if [[ -n "$latest" ]]; then
                    less "$latest"
                else
                    echo "No logs" && sleep 1
                fi
                _tui_reenter
                ;;
        esac
    done
}

_tui_reenter() {
    printf '\033[?1049h'
    tput civis 2>/dev/null || true
    if [[ -t 0 ]]; then
        stty -echo -icanon min 0 time 0 2>/dev/null || true
    fi
}

_tui_cleanup_soft() {
    printf '\033[?1049l'
    tput cnorm 2>/dev/null || true
    stty echo icanon 2>/dev/null || true
}

_tui_cleanup() {
    _dbg "cleanup triggered (trap)"
    _tui_cleanup_soft
    if [[ -n "$TUI_DEBUG" && -n "$TUI_DEBUG_LOG" ]]; then
        _dbg "=== TUI debug end ==="
        echo "Debug log saved: $TUI_DEBUG_LOG" >&2
    fi
    trap - EXIT INT TERM
    exit 0
}

# Main
main() {
    local action="${1:-show}"
    local task="${2:-}"
    local metadata_file=""

    if [[ "${2:-}" == "--metadata-file" ]]; then
        metadata_file="${3:-}"
        task="${4:-}"
    fi
    
    case "$action" in
        show|state)
            show_state
            ;;
        launch|run)
            launch_opencode_tmux "$task"
            ;;
        headless)
            # Direct execution without tmux — outputs to stdout + log file
            # Useful when called from Claude Code or CI
            if [[ -z "$task" ]]; then
                echo -e "${RED}Error: task description required${NC}"
                echo "Usage: $0 headless \"task description\""
                exit 1
            fi
            local model
            model=$(_detect_model)
            if [[ -n "$model" ]]; then
                echo -e "${BLUE}Model:${NC} $model"
            fi
            local log_file
            local run_root="$PROJECT_ROOT"
            if [[ -n "$metadata_file" ]]; then
                unset WORKTREE_PATH LOG_FILE BRANCH_NAME TASK_DIR
                _load_run_metadata "$metadata_file" || true
                [[ -n "${WORKTREE_PATH:-}" ]] && run_root="$WORKTREE_PATH"
                [[ -n "${LOG_FILE:-}" ]] && log_file="$LOG_FILE"
            else
                local run_id slug task_dir branch_name session_name
                run_id="$(date +%Y%m%d_%H%M%S)"
                slug=$(_slugify_task "$task")
                task_dir=$(pipeline_task_dir_create "$slug" "ultraworks" "$task")
                branch_name=$(git -C "$PROJECT_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
                session_name="ultraworks-headless-${slug}-${run_id}"
                _link_task_handoff "$PROJECT_ROOT" "$task_dir"
                _write_task_meta "$task_dir" "ultraworks" "$run_id" "$slug" "$task" "$branch_name" "$PROJECT_ROOT" "$session_name"
                pipeline_task_append_event "$task_dir" "task_created" "Headless Ultraworks task directory initialized"
                _write_task_state "$task_dir" "" "planner"
                metadata_file=$(_metadata_path "$run_id")
                log_file="$PROJECT_ROOT/.opencode/pipeline/logs/task-${run_id}-${slug}.log"
                mkdir -p "$(dirname "$log_file")"
                _write_run_metadata "$metadata_file" \
                    RUN_ID "$run_id" \
                    TASK_SLUG "$slug" \
                    TASK_TEXT "$task" \
                    TASK_DIR "$task_dir" \
                    BRANCH_NAME "$branch_name" \
                    WORKTREE_PATH "$PROJECT_ROOT" \
                    SESSION_NAME "$session_name" \
                    RUN_STATUS "preparing" \
                    LOG_FILE "$log_file"
            fi
            if [[ -z "${log_file:-}" ]]; then
                log_file=$(_task_log_path "$task")
            fi
            local start_epoch
            start_epoch=$(date +%s)
            echo -e "${GREEN}Running Sisyphus pipeline (headless)...${NC}"
            echo -e "${BLUE}Task:${NC} $task"
            echo -e "${BLUE}Log:${NC} $log_file"
            if [[ -n "$metadata_file" ]]; then
                [[ -n "${BRANCH_NAME:-}" ]] && echo -e "${BLUE}Branch:${NC} ${BRANCH_NAME}"
                [[ -n "${WORKTREE_PATH:-}" ]] && echo -e "${BLUE}Worktree:${NC} ${WORKTREE_PATH}"
            fi
            if command -v timeout &>/dev/null && [[ "$ULTRAWORKS_MAX_RUNTIME" =~ ^[0-9]+$ ]] && (( ULTRAWORKS_MAX_RUNTIME > 0 )); then
                echo -e "${BLUE}Max runtime:${NC} ${ULTRAWORKS_MAX_RUNTIME}s"
            fi
            if [[ "$ULTRAWORKS_STALL_TIMEOUT" =~ ^[0-9]+$ ]] && (( ULTRAWORKS_STALL_TIMEOUT > 0 )); then
                echo -e "${BLUE}Stall watchdog:${NC} ${ULTRAWORKS_STALL_TIMEOUT}s"
            fi
            echo ""
            _run_headless_pipeline "$task" "$model" "$log_file" "$start_epoch" "$run_root" "$metadata_file"
            exit $?
            ;;
        logs)
            # Show recent task logs
            local selected_metadata
            selected_metadata=$(_selected_run_metadata)
            local pipeline_dir
            pipeline_dir=$(_pipeline_dir_for_metadata "$selected_metadata")
            local log_dir="$pipeline_dir/logs"
            if [[ -n "$task" ]]; then
                # View specific log
                if [[ -f "$task" ]]; then
                    less "$task"
                elif [[ -f "$log_dir/$task" ]]; then
                    less "$log_dir/$task"
                else
                    # Search by pattern
                    local found
                    found=$(ls -t "$log_dir"/task-*"$task"* 2>/dev/null | head -1)
                    if [[ -n "$found" ]]; then
                        less "$found"
                    else
                        echo -e "${RED}No log matching '$task'${NC}"
                        echo "Available logs:"
                        ls -lt "$log_dir"/task-*.log 2>/dev/null | head -10 | awk '{print "  " $NF}'
                    fi
                fi
            else
                # List recent logs
                echo -e "${CYAN}Recent task logs:${NC}"
                ls -lt "$log_dir"/task-*.log 2>/dev/null | head -15 | while read -r line; do
                    local f=$(echo "$line" | awk '{print $NF}')
                    local sz=$(echo "$line" | awk '{print $5}')
                    local dt=$(echo "$line" | awk '{print $6, $7, $8}')
                    local name=$(basename "$f")
                    # Check if log ends with "Pipeline finished" (success) or has error
                    local status="?"
                    if tail -5 "$f" 2>/dev/null | grep -q "Pipeline finished"; then
                        status="done"
                    elif tail -20 "$f" 2>/dev/null | grep -qi "error\|failed\|exception"; then
                        status="FAIL"
                    elif [[ $sz -lt 100 ]]; then
                        status="empty"
                    fi
                    printf "  %-8s %6s  %s  %s\n" "[$status]" "$(numfmt --to=iec $sz 2>/dev/null || echo ${sz}B)" "$dt" "$name"
                done || echo "  (no task logs)"
                echo ""
                echo -e "View a log: ${CYAN}$0 logs <filename-or-pattern>${NC}"
            fi
            ;;
        watch)
            # Live TUI with split panels — agent sidebar on the right
            # Usage: watch [--debug] [refresh_seconds]
            local watch_refresh=3
            for arg in "${@:2}"; do
                case "$arg" in
                    --debug) TUI_DEBUG=1 ;;
                    [0-9]*) watch_refresh="$arg" ;;
                esac
            done
            _tui_watch "$watch_refresh"
            ;;
        attach)
            local selected_metadata
            selected_metadata=$(_selected_run_metadata)
            local selected_session="ultraworks"
            if [[ -n "$selected_metadata" ]]; then
                unset SESSION_NAME
                _load_run_metadata "$selected_metadata" || true
                [[ -n "${SESSION_NAME:-}" ]] && selected_session="$SESSION_NAME"
            fi
            tmux attach -t "$selected_session" 2>/dev/null || echo -e "${YELLOW}No ultraworks session. Run: $0 launch \"task\"${NC}"
            ;;
        menu|interactive)
            interactive_menu
            ;;
        *)
            show_state
            echo ""
            echo -e "${CYAN}Usage: $0 [show|launch|headless|watch|logs|attach|menu] [task description]${NC}"
            echo ""
            echo "Commands:"
            echo "  show      Show current pipeline state (default)"
            echo "  watch     Live TUI monitor with agent sidebar (split-panel)"
            echo "  launch    Start Sisyphus pipeline in tmux session (logs to file)"
            echo "  headless  Run pipeline directly (stdout + log file)"
            echo "  logs      List recent task logs, or view one: logs <pattern>"
            echo "  attach    Attach to existing tmux session"
            echo "  menu      Interactive menu"
            echo ""
            echo "Examples:"
            echo "  $0 watch                   # live split-panel monitor"
            echo "  $0 launch \"Implement user authentication\""
            echo "  $0 headless \"Add metrics dashboard\""
            echo "  $0 logs                    # list recent logs"
            echo "  $0 logs e2e                # view latest log matching 'e2e'"
            echo "  $0 attach"
            ;;
    esac
}

main "$@"
