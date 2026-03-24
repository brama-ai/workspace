#!/usr/bin/env bash
# shellcheck disable=SC2034
#
# Interactive Foundry pipeline monitor with tab-based TUI.
# Version: 1.0.0
#
MONITOR_VERSION="1.0.0"
# Usage:
#   ./agentic-development/foundry.sh              # launch via foundry.sh (recommended)
#   ./agentic-development/lib/pipeline-monitor.sh # direct launch
#   ./agentic-development/lib/pipeline-monitor.sh /path/to/tasks/root
#
# Tabs:
#   [1] Overview   — task statuses, progress bar, timing
#   [2] Activity   — timeline of task & agent events (from events.jsonl)
#
# Keys:
#   ←/→ or 1-2  Switch tabs
#   ↑/↓         Select task (Overview tab)
#   Enter       View selected task detail
#   Esc/Bksp    Back to task list
#   s           Start headless workers
#   k           Kill running workers
#   f           Retry failed tasks
#   u           Resume selected suspended task
#   U           Resume ALL suspended tasks
#   d           Delete selected pending/failed/suspended task
#   +           Raise priority of selected pending task
#   -           Lower priority of selected pending task
#   l           View task.md for selected task
#   r           Refresh
#   q/Ctrl-C    Quit (or back from log/detail view)
#
# Task priority:
#   Tasks are sorted by priority from task.md first line:
#     <!-- priority: 5 -->
#   Higher number = higher priority. Default priority = 1.
#   Use [+] and [-] keys to adjust priority of the selected pending task.
#
set -uo pipefail
shopt -s extglob

REPO_ROOT="$(cd "$(dirname "$(readlink -f "$0" 2>/dev/null || realpath "$0" 2>/dev/null || echo "$0")")/../.." && pwd)"

# shellcheck source=/dev/null
source "$REPO_ROOT/agentic-development/lib/foundry-common.sh"

# Allow override of task root via argument
if [[ -n "${1:-}" && -d "$1" ]]; then
  PIPELINE_TASKS_ROOT="$1"
  FOUNDRY_TASK_ROOT="$1"
fi

LOG_DIR="$REPO_ROOT/.opencode/pipeline/logs"
REPORT_DIR="$REPO_ROOT/.opencode/pipeline/reports"
LOG_RETENTION_DAYS="${MONITOR_LOG_RETENTION:-7}"

# Load .env.local for API keys (if exists)
if [[ -f "$REPO_ROOT/.env.local" ]]; then
  # shellcheck disable=SC1091
  set -a; source "$REPO_ROOT/.env.local" 2>/dev/null; set +a
fi

# ── Colors ────────────────────────────────────────────────────────────
if command -v tput &>/dev/null && [[ -t 1 ]]; then
  BOLD=$(tput bold); DIM=$(tput dim); REV=$(tput rev); RESET=$(tput sgr0)
  RED=$(tput setaf 1); GREEN=$(tput setaf 2); YELLOW=$(tput setaf 3)
  BLUE=$(tput setaf 4); MAGENTA=$(tput setaf 5); CYAN=$(tput setaf 6)
  WHITE=$(tput setaf 7)
else
  BOLD='' DIM='' REV='' RESET=''
  RED='' GREEN='' YELLOW='' BLUE='' MAGENTA='' CYAN='' WHITE=''
fi

# ── State ─────────────────────────────────────────────────────────────
CURRENT_TAB=1
MAX_TABS=2
SELECTED_IDX=0
DETAIL_MODE=false
DETAIL_FILE=""
LOG_VIEW_MODE=false
LOG_VIEW_FILE=""
ACTION_MSG=""
REFRESH_INTERVAL=3
AUTOSTART="${MONITOR_AUTOSTART:-true}"
AUTOSTART_COOLDOWN=5
AUTOSTART_LAST=0

# ── Cache control ────────────────────────────────────────────────────
RENDER_CYCLE=0
CACHE_TTL=2
FORCE_REBUILD=true
CACHED_PENDING_COUNT=0
CACHED_INPROG_COUNT=0
CACHED_COMPLETED_COUNT=0
CACHED_FAILED_COUNT=0
CACHED_SUSPENDED_COUNT=0
CACHED_CANCELLED_COUNT=0

cache_expired() { [[ "$FORCE_REBUILD" == true ]] || (( RENDER_CYCLE % CACHE_TTL == 0 )); }
invalidate_cache() { FORCE_REBUILD=true; }

# Task list arrays (populated by build_task_list)
ALL_TASKS_DIRS=()
ALL_TASKS_TITLES=()
ALL_TASKS_STATES=()
ALL_TASKS_COUNT=0

# ── Buffer renderer (flicker-free) ───────────────────────────────────
ESC=$'\033'
CLR="${ESC}[2K"
RENDER_BUF=""
PREV_LINE_COUNT=0

buf_reset() { RENDER_BUF=""; }
buf_line()  { RENDER_BUF+="${CLR}${1}"$'\n'; }
buf_flush() {
  local cur_lines
  cur_lines=$(printf '%s' "$RENDER_BUF" | wc -l | tr -d ' ')
  printf '%s[H' "$ESC"
  printf '%s' "$RENDER_BUF"
  local i
  for ((i=cur_lines; i<PREV_LINE_COUNT; i++)); do
    printf '%s\n' "$CLR"
  done
  if [[ $cur_lines -lt $PREV_LINE_COUNT ]]; then
    printf '%s[%dA' "$ESC" "$((PREV_LINE_COUNT - cur_lines))"
  fi
  PREV_LINE_COUNT=$cur_lines
}

# ── Log auto-cleanup (runs once on startup) ──────────────────────────
LOG_CLEANUP_DONE=false
cleanup_old_logs() {
  [[ "$LOG_CLEANUP_DONE" == true ]] && return
  LOG_CLEANUP_DONE=true
  [[ "$LOG_RETENTION_DAYS" -le 0 ]] 2>/dev/null && return
  local cleaned=0
  if [[ -d "$LOG_DIR" ]]; then
    while IFS= read -r f; do
      [[ -n "$f" ]] && rm -f "$f" && (( cleaned++ ))
    done < <(find "$LOG_DIR" -maxdepth 1 \( -name '*.log' -o -name '*.meta.json' \) -mtime +"$LOG_RETENTION_DAYS" 2>/dev/null)
  fi
  if [[ -d "$REPORT_DIR" ]]; then
    while IFS= read -r f; do
      [[ -n "$f" ]] && rm -f "$f" && (( cleaned++ ))
    done < <(find "$REPORT_DIR" -maxdepth 1 -name 'batch_*.md' -mtime +"$LOG_RETENTION_DAYS" 2>/dev/null)
  fi
  [[ $cleaned -gt 0 ]] && ACTION_MSG="${DIM}Cleaned $cleaned old log/report files (>${LOG_RETENTION_DAYS}d)${RESET}"
}

# ── Stub functions (cost tracking removed) ───────────────────────────
query_openrouter_balance() { :; }
aggregate_batch_tokens() { :; }
build_provider_line() { :; }
render_cost_bar() { :; }

# ── Environment report reader ─────────────────────────────────────────
get_env_status_line() {
  local report_file="$REPO_ROOT/.opencode/pipeline/env-report.json"
  [[ -f "$report_file" ]] || return 0

  if ! command -v jq &>/dev/null; then
    printf '%s' "${DIM}Env: report available (jq required to display)${RESET}"
    return 0
  fi

  local exit_code summary
  exit_code=$(jq -r '.exit_code // -1' "$report_file" 2>/dev/null)
  summary=$(jq -r '.summary // ""' "$report_file" 2>/dev/null)

  if [[ "$exit_code" == "2" ]]; then
    local fatal_names
    fatal_names=$(jq -r '[.checks[] | select(.status == "fail") | .name] | join(", ")' "$report_file" 2>/dev/null)
    printf '%s' "${RED}Env: FAILED — ${fatal_names}${RESET}"
  elif [[ "$exit_code" == "1" ]]; then
    local versions
    versions=$(jq -r '.environment | to_entries | map(select(.value != "")) | map("\(.key) \(.value)") | join(" | ")' "$report_file" 2>/dev/null)
    printf '%s' "${YELLOW}Env: WARN — ${versions}${RESET}"
  elif [[ "$exit_code" == "0" ]]; then
    local versions check_count
    versions=$(jq -r '.environment | to_entries | map(select(.value != "")) | map("\(.key) \(.value)") | join(" | ")' "$report_file" 2>/dev/null)
    check_count=$(jq -r '.checks | length' "$report_file" 2>/dev/null)
    printf '%s' "${GREEN}Env: ${versions} | ${check_count} checks ✓${RESET}"
  fi
}

get_terminal_size() {
  TERM_ROWS=$(tput lines 2>/dev/null || echo 24)
  TERM_COLS=$(tput cols 2>/dev/null || echo 80)
}

hline() { printf '%*s' "$TERM_COLS" '' | tr ' ' "${1:-─}"; }

progress_bar_str() {
  local done_n="$1" total="$2"
  local width=$((TERM_COLS - 20))
  [[ $width -lt 10 ]] && width=10
  if [[ $total -eq 0 ]]; then
    printf "[%*s] 0/0" "$width" ""
    return
  fi
  local filled=$(( done_n * width / total ))
  local empty=$(( width - filled ))
  printf "${GREEN}["
  printf '%*s' "$filled" '' | tr ' ' '█'
  printf '%*s' "$empty" '' | tr ' ' '░'
  printf "]${RESET} %d/%d" "$done_n" "$total"
}

format_duration() {
  local secs="$1"
  if [[ $secs -ge 3600 ]]; then
    printf "%dh %dm %ds" $((secs/3600)) $((secs%3600/60)) $((secs%60))
  elif [[ $secs -ge 60 ]]; then
    printf "%dm %ds" $((secs/60)) $((secs%60))
  else
    printf "%ds" "$secs"
  fi
}

format_epoch() {
  date -d "@$1" '+%H:%M:%S' 2>/dev/null || echo "??:??:??"
}

format_tokens() {
  local n="$1"
  if [[ $n -ge 1000000 ]]; then
    printf '%.1fM' "$(echo "$n" | awk '{printf "%.1f", $1/1000000}')"
  elif [[ $n -ge 1000 ]]; then
    printf '%.1fk' "$(echo "$n" | awk '{printf "%.1f", $1/1000}')"
  else
    printf '%d' "$n"
  fi
}

# ── Task counts (Foundry state.json-based) ────────────────────────────
count_all_task_dirs() {
  cache_expired || return 0
  CACHED_PENDING_COUNT=0
  CACHED_INPROG_COUNT=0
  CACHED_COMPLETED_COUNT=0
  CACHED_FAILED_COUNT=0
  CACHED_SUSPENDED_COUNT=0
  CACHED_CANCELLED_COUNT=0
  while IFS='=' read -r key value; do
    case "$key" in
      pending)    CACHED_PENDING_COUNT="$value" ;;
      in_progress) CACHED_INPROG_COUNT="$value" ;;
      completed)  CACHED_COMPLETED_COUNT="$value" ;;
      failed)     CACHED_FAILED_COUNT="$value" ;;
      suspended)  CACHED_SUSPENDED_COUNT="$value" ;;
      cancelled)  CACHED_CANCELLED_COUNT="$value" ;;
    esac
  done < <(foundry_task_counts)
}

# ── Priority helpers ──────────────────────────────────────────────────
get_priority() {
  local task_file="$1/task.md"
  local prio
  prio=$(head -1 "$task_file" 2>/dev/null | sed -n 's/.*<!-- *priority: *\([0-9]*\) *-->.*/\1/p')
  echo "${prio:-1}"
}

set_priority() {
  local task_dir="$1" prio="$2"
  local task_file="$task_dir/task.md"
  [[ -f "$task_file" ]] || return
  local first_line
  first_line=$(head -1 "$task_file" 2>/dev/null)
  if [[ "$first_line" =~ \<!--\ *priority: ]]; then
    sed -i "1s/<!-- *priority: *[0-9]* *-->/<!-- priority: ${prio} -->/" "$task_file"
  else
    local tmp; tmp=$(mktemp)
    echo "<!-- priority: ${prio} -->" > "$tmp"
    cat "$task_file" >> "$tmp"
    mv "$tmp" "$task_file"
  fi
}

# ── Extract title from task.md ────────────────────────────────────────
_extract_title() {
  local task_dir="$1"
  local task_file="$task_dir/task.md"
  local line=""
  while IFS= read -r line; do
    if [[ "$line" == "# "* ]]; then
      printf '%s' "${line#\# }"
      return
    fi
  done < "$task_file" 2>/dev/null
  basename "$task_dir" | sed 's/--foundry.*//'
}

# ── Task list builder (Foundry state.json-based) ──────────────────────
build_task_list() {
  if ! cache_expired; then return; fi
  ALL_TASKS_DIRS=(); ALL_TASKS_TITLES=(); ALL_TASKS_STATES=()

  # Collect all task dirs with their status
  local task_dir status title prio
  local pending_dirs=() inprog_dirs=() completed_dirs=() failed_dirs=() suspended_dirs=()

  while IFS= read -r task_dir; do
    [[ -d "$task_dir" ]] || continue
    status=$(foundry_state_field "$task_dir" status 2>/dev/null || echo "pending")
    case "$status" in
      in_progress) inprog_dirs+=("$task_dir") ;;
      completed)   completed_dirs+=("$task_dir") ;;
      failed)      failed_dirs+=("$task_dir") ;;
      suspended)   suspended_dirs+=("$task_dir") ;;
      cancelled)   ;; # skip cancelled from list
      *)           pending_dirs+=("$task_dir") ;;
    esac
  done < <(foundry_list_task_dirs)

  # Add in order: in_progress, completed, failed, suspended, pending (sorted by priority)
  local d
  for d in "${inprog_dirs[@]+"${inprog_dirs[@]}"}"; do
    title=$(_extract_title "$d")
    ALL_TASKS_DIRS+=("$d")
    ALL_TASKS_TITLES+=("$title")
    ALL_TASKS_STATES+=("in_progress")
  done
  for d in "${completed_dirs[@]+"${completed_dirs[@]}"}"; do
    title=$(_extract_title "$d")
    ALL_TASKS_DIRS+=("$d")
    ALL_TASKS_TITLES+=("$title")
    ALL_TASKS_STATES+=("completed")
  done
  for d in "${failed_dirs[@]+"${failed_dirs[@]}"}"; do
    title=$(_extract_title "$d")
    ALL_TASKS_DIRS+=("$d")
    ALL_TASKS_TITLES+=("$title")
    ALL_TASKS_STATES+=("failed")
  done
  for d in "${suspended_dirs[@]+"${suspended_dirs[@]}"}"; do
    title=$(_extract_title "$d")
    ALL_TASKS_DIRS+=("$d")
    ALL_TASKS_TITLES+=("$title")
    ALL_TASKS_STATES+=("suspended")
  done

  # Sort pending by priority (descending)
  if [[ ${#pending_dirs[@]} -gt 0 ]]; then
    local entries=()
    for d in "${pending_dirs[@]}"; do
      prio=$(get_priority "$d")
      entries+=("$(printf '%03d|%s' "$prio" "$d")")
    done
    while IFS='|' read -r p dir; do
      title=$(_extract_title "$dir")
      ALL_TASKS_DIRS+=("$dir")
      ALL_TASKS_TITLES+=("$title")
      ALL_TASKS_STATES+=("pending:${p#0*}")
    done < <(printf '%s\n' "${entries[@]}" | sort -t'|' -k1 -rn)
  fi

  ALL_TASKS_COUNT=${#ALL_TASKS_DIRS[@]}
  if [[ $SELECTED_IDX -ge $ALL_TASKS_COUNT ]]; then
    SELECTED_IDX=$((ALL_TASKS_COUNT > 0 ? ALL_TASKS_COUNT - 1 : 0))
  fi
}

# ── Tab bar ───────────────────────────────────────────────────────────
render_tabs_str() {
  local out="  "
  if [[ $CURRENT_TAB -eq 1 ]]; then
    out+="${REV}${BOLD} 1:Overview ${RESET}"
  else
    out+="${DIM} 1:Overview ${RESET}"
  fi
  if [[ $CURRENT_TAB -eq 2 ]]; then
    out+="${REV}${BOLD} 2:Activity ${RESET}"
  else
    out+="${DIM} 2:Activity ${RESET}"
  fi
  printf '%s' "$out"
}

# ── Colorized log renderer ───────────────────────────────────────────
render_log_lines() {
  local log_file="$1" lines="$2"
  while IFS= read -r line; do
    if [[ "$line" == *"error"* || "$line" == *"Error"* || "$line" == *"FAIL"* ]]; then
      buf_line "  ${RED}$line${RESET}"
    elif [[ "$line" == *"✓"* || "$line" == *"PASS"* || "$line" == *"success"* ]]; then
      buf_line "  ${GREEN}$line${RESET}"
    elif [[ "$line" == *"──"* || "$line" == *"═══"* ]]; then
      buf_line "  ${CYAN}$line${RESET}"
    else
      buf_line "  $line"
    fi
  done < <(tail -n "$lines" "$log_file" 2>/dev/null)
}

# ── Tab: Overview ─────────────────────────────────────────────────────
render_overview() {
  get_terminal_size
  buf_reset
  count_all_task_dirs
  build_task_list

  local pending_count=$CACHED_PENDING_COUNT
  local in_progress_count=$CACHED_INPROG_COUNT
  local completed_count=$CACHED_COMPLETED_COUNT
  local failed_count=$CACHED_FAILED_COUNT
  local suspended_count=$CACHED_SUSPENDED_COUNT
  local total=$((pending_count + in_progress_count + completed_count + failed_count + suspended_count))
  local done_n=$((completed_count + failed_count))

  buf_line "${CYAN}${BOLD}  Foundry Monitor${RESET} ${DIM}v${MONITOR_VERSION}${RESET}  $(date '+%H:%M:%S')"
  buf_line "${DIM}$(hline)${RESET}"
  buf_line "$(render_tabs_str)"
  buf_line ""

  if [[ "$LOG_VIEW_MODE" == true ]]; then
    render_task_log_view_buf
    buf_flush
    return
  fi

  if [[ "$DETAIL_MODE" == true && -n "$DETAIL_FILE" && -f "$DETAIL_FILE" ]]; then
    render_task_detail_buf
    buf_flush
    return
  fi

  buf_line "  $(progress_bar_str "$done_n" "$total")"
  buf_line ""
  local counter_line
  counter_line=$(printf "  ${BLUE}${BOLD}⏳ Pending:${RESET}      %-4d  ${YELLOW}${BOLD}🔄 In Progress:${RESET} %-4d  ${GREEN}${BOLD}✓ Done:${RESET}        %-4d  ${RED}${BOLD}✗ Failed:${RESET}      %-4d" "$pending_count" "$in_progress_count" "$completed_count" "$failed_count")
  [[ $suspended_count -gt 0 ]] && counter_line+=$(printf "  ${MAGENTA}${BOLD}⏸ Suspended:${RESET}   %-4d" "$suspended_count")
  buf_line "$counter_line"
  buf_line ""

  # Status line
  if foundry_is_batch_running; then
    buf_line "  ${BOLD}Status:${RESET} ${GREEN}Running${RESET}"
  else
    if [[ $pending_count -gt 0 ]]; then
      if [[ "$AUTOSTART" == "true" ]]; then
        buf_line "  ${BOLD}Status:${RESET} ${CYAN}Auto-start${RESET} — ${BOLD}${pending_count} tasks waiting${RESET}, launching workers…"
      else
        buf_line "  ${BOLD}Status:${RESET} ${YELLOW}Not running${RESET} — ${BOLD}${pending_count} tasks waiting${RESET}, press ${WHITE}[s]${RESET} to start"
      fi
    else
      buf_line "  ${BOLD}Status:${RESET} ${DIM}Not running${RESET}"
    fi
  fi

  # Environment status line
  local env_line
  env_line=$(get_env_status_line)
  [[ -n "$env_line" ]] && buf_line "  ${env_line}"
  buf_line ""
  buf_line "${DIM}$(hline)${RESET}"

  # Task list with cursor
  local available_lines=$((TERM_ROWS - 18))
  [[ $available_lines -lt 5 ]] && available_lines=5
  local scroll_start=0
  [[ $SELECTED_IDX -ge $available_lines ]] && scroll_start=$((SELECTED_IDX - available_lines + 1))

  local prev_state=""
  local i
  for ((i=0; i<ALL_TASKS_COUNT; i++)); do
    [[ $i -lt $scroll_start ]] && continue
    if [[ $((i - scroll_start)) -ge $available_lines ]]; then
      buf_line "  ${DIM}  ... $((ALL_TASKS_COUNT - i)) more${RESET}"
      break
    fi
    local state="${ALL_TASKS_STATES[$i]}" title="${ALL_TASKS_TITLES[$i]}" task_dir="${ALL_TASKS_DIRS[$i]}"
    local state_base="${state%%:*}"
    if [[ "$state_base" != "$prev_state" ]]; then
      case "$state_base" in
        in_progress) buf_line "  ${YELLOW}${BOLD}In Progress:${RESET}" ;;
        completed)   buf_line "  ${GREEN}${BOLD}Completed:${RESET}" ;;
        failed)      buf_line "  ${RED}${BOLD}Failed:${RESET}" ;;
        suspended)   buf_line "  ${MAGENTA}${BOLD}Suspended:${RESET}" ;;
        pending)     buf_line "  ${BLUE}${BOLD}Pending:${RESET} ${DIM}(priority order)${RESET}" ;;
      esac
      prev_state="$state_base"
    fi
    local cursor="  "
    [[ $i -eq $SELECTED_IDX ]] && cursor="${CYAN}▶${RESET} "
    case "$state_base" in
      in_progress)
        local current_step
        current_step=$(foundry_state_field "$task_dir" current_step 2>/dev/null || echo "")
        local step_label=""
        [[ -n "$current_step" ]] && step_label=" ${DIM}[${current_step}]${RESET}"
        buf_line "  ${cursor}  ${YELLOW}▸${RESET} $title${step_label}"
        ;;
      completed)
        local started_at updated_at duration_str=""
        started_at=$(foundry_state_field "$task_dir" started_at 2>/dev/null || echo "")
        updated_at=$(foundry_state_field "$task_dir" updated_at 2>/dev/null || echo "")
        if [[ -n "$started_at" && -n "$updated_at" ]]; then
          local s_epoch u_epoch
          s_epoch=$(date -d "$started_at" +%s 2>/dev/null || echo "0")
          u_epoch=$(date -d "$updated_at" +%s 2>/dev/null || echo "0")
          if [[ "$s_epoch" -gt 0 && "$u_epoch" -gt 0 ]]; then
            local dur=$(( u_epoch - s_epoch ))
            [[ $dur -gt 0 ]] && duration_str=" ${DIM}($(format_duration "$dur"))${RESET}"
          fi
        fi
        buf_line "  ${cursor}  ${GREEN}✓${RESET} $title${duration_str}"
        ;;
      failed)
        buf_line "  ${cursor}  ${RED}✗${RESET} $title"
        ;;
      suspended)
        buf_line "  ${cursor}  ${MAGENTA}⏸${RESET} ${DIM}${title}${RESET}"
        ;;
      pending)
        local prio="${state#pending:}" prio_label=""
        [[ -n "$prio" && "$prio" -gt 1 ]] 2>/dev/null && prio_label=" ${MAGENTA}#${prio}${RESET}"
        buf_line "  ${cursor}  ${DIM}○${RESET} ${title}${prio_label}"
        ;;
    esac
  done

  buf_line ""
  buf_line "${DIM}$(hline)${RESET}"
  render_cost_bar
  [[ -n "$ACTION_MSG" ]] && { buf_line "  $ACTION_MSG"; ACTION_MSG=""; }
  render_bottom_menu_buf
  buf_flush
}

# ── Context-aware bottom menu ─────────────────────────────────────────
render_bottom_menu_buf() {
  local state=""
  [[ $ALL_TASKS_COUNT -gt 0 && $SELECTED_IDX -lt $ALL_TASKS_COUNT ]] && state="${ALL_TASKS_STATES[$SELECTED_IDX]%%:*}"
  local batch_running=false; foundry_is_batch_running && batch_running=true

  local keys="  ${DIM}←/→ tabs  ↑/↓ select  Enter detail"
  case "$state" in
    in_progress) keys="$keys  ${WHITE}[l]${DIM} view task" ;;
    failed)      keys="$keys  ${WHITE}[f]${DIM} retry  ${WHITE}[d]${DIM} delete  ${WHITE}[l]${DIM} view task" ;;
    suspended)   keys="$keys  ${WHITE}[u]${DIM} resume  ${WHITE}[U]${DIM} resume all  ${WHITE}[d]${DIM} delete" ;;
    pending)
      keys="$keys  ${WHITE}[+]${DIM} prio+  ${WHITE}[-]${DIM} prio-  ${WHITE}[d]${DIM} delete"
      ;;
    completed)   keys="$keys  ${WHITE}[l]${DIM} view task" ;;
  esac
  ! $batch_running && keys="$keys  ${WHITE}[s]${DIM} start"
  $batch_running && keys="$keys  ${WHITE}[k]${DIM} stop"
  keys="$keys  ${WHITE}[q]${DIM} quit${RESET}"
  buf_line "$keys"
}

# ── Task detail view ──────────────────────────────────────────────────
render_task_detail_buf() {
  buf_line ""
  buf_line "  ${BOLD}Task Detail${RESET}  ${DIM}(Esc to go back)${RESET}"
  buf_line ""
  local title; title=$(grep -m1 '^# ' "$DETAIL_FILE" 2>/dev/null | sed 's/^# //' || basename "$(dirname "$DETAIL_FILE")")
  buf_line "  ${BOLD}$title${RESET}"
  buf_line ""
  local available_lines=$((TERM_ROWS - 14))
  [[ $available_lines -lt 5 ]] && available_lines=5
  while IFS= read -r line; do
    buf_line "  $line"
  done < <(grep -v '^<!-- priority:' "$DETAIL_FILE" 2>/dev/null | head -n "$available_lines")
  buf_line ""
  buf_line "${DIM}$(hline)${RESET}"
  buf_line "  ${DIM}Esc back  [q] quit${RESET}"
}

# ── Task log view (shows task.md) ────────────────────────────────────
render_task_log_view_buf() {
  if [[ -z "$LOG_VIEW_FILE" || ! -f "$LOG_VIEW_FILE" ]]; then
    buf_line "  ${DIM}No file found for this task${RESET}"
    buf_line "  ${DIM}q/Esc back${RESET}"
  else
    local log_name="${LOG_VIEW_FILE##*/}"
    local log_size
    log_size=$(wc -c < "$LOG_VIEW_FILE" | tr -d ' ')
    buf_line "  ${BOLD}Task File${RESET}  ${DIM}${log_name}  $(( log_size / 1024 ))KB  (q/Esc back)${RESET}"
    local available_lines=$((TERM_ROWS - 7))
    [[ $available_lines -lt 5 ]] && available_lines=5
    render_log_lines "$LOG_VIEW_FILE" "$available_lines"
  fi
}

# ── Tab: Activity (events.jsonl-based) ────────────────────────────────
ACTIVITY_EVENTS=()
ACTIVITY_TASK_TITLE=""
ACTIVITY_TASK_STARTED=0

build_activity_data() {
  ACTIVITY_EVENTS=()
  ACTIVITY_TASK_TITLE=""
  ACTIVITY_TASK_STARTED=0

  # Find the most recently active task (in_progress first, then most recently updated)
  local active_task_dir=""
  local task_dir status

  # First try in_progress
  while IFS= read -r task_dir; do
    [[ -d "$task_dir" ]] || continue
    status=$(foundry_state_field "$task_dir" status 2>/dev/null || echo "pending")
    if [[ "$status" == "in_progress" ]]; then
      active_task_dir="$task_dir"
      break
    fi
  done < <(foundry_list_task_dirs)

  # If no in_progress, find most recently updated
  if [[ -z "$active_task_dir" ]]; then
    local newest_mtime=0
    while IFS= read -r task_dir; do
      [[ -d "$task_dir" ]] || continue
      local events_file="$task_dir/events.jsonl"
      [[ -f "$events_file" ]] || continue
      local mtime
      mtime=$(stat -c %Y "$events_file" 2>/dev/null || echo "0")
      if [[ "$mtime" -gt "$newest_mtime" ]]; then
        newest_mtime="$mtime"
        active_task_dir="$task_dir"
      fi
    done < <(foundry_list_task_dirs)
  fi

  [[ -z "$active_task_dir" ]] && return

  # Get task title
  ACTIVITY_TASK_TITLE=$(_extract_title "$active_task_dir")

  # Get started_at from state.json
  local started_at
  started_at=$(foundry_state_field "$active_task_dir" started_at 2>/dev/null || echo "")
  if [[ -n "$started_at" ]]; then
    ACTIVITY_TASK_STARTED=$(date -d "$started_at" +%s 2>/dev/null || echo "0")
  fi

  # Read events.jsonl
  local events_file="$active_task_dir/events.jsonl"
  [[ -f "$events_file" ]] || return

  # Parse JSONL events using python3
  while IFS= read -r event_line; do
    [[ -n "$event_line" ]] && ACTIVITY_EVENTS+=("$event_line")
  done < "$events_file"
}

render_logs_tab() {
  get_terminal_size
  buf_reset
  buf_line "$(render_tabs_str)  ${DIM}v${MONITOR_VERSION}  $(date '+%H:%M:%S')${RESET}"

  build_activity_data

  # Header: current task
  if [[ -n "$ACTIVITY_TASK_TITLE" ]]; then
    buf_line "  ${BOLD}${WHITE}${ACTIVITY_TASK_TITLE}${RESET}"
  else
    buf_line "  ${BOLD}Foundry Activity${RESET}"
  fi

  local now; now=$(date +%s)

  # Elapsed time
  if [[ "$ACTIVITY_TASK_STARTED" -gt 0 ]]; then
    local elapsed=$(( now - ACTIVITY_TASK_STARTED ))
    buf_line "  ${DIM}Elapsed: $(format_duration "$elapsed")${RESET}"
  fi
  buf_line ""

  local available_lines=$((TERM_ROWS - 8))
  [[ $available_lines -lt 5 ]] && available_lines=5
  local shown=0

  if [[ ${#ACTIVITY_EVENTS[@]} -eq 0 ]]; then
    buf_line "  ${DIM}No activity yet. Waiting for pipeline to start...${RESET}"
    buf_line "  ${DIM}Press [s] to start manually${RESET}"
    shown=2
  else
    # Show last N events (newest at bottom for timeline feel)
    local total_events=${#ACTIVITY_EVENTS[@]}
    local start_idx=$(( total_events > available_lines ? total_events - available_lines : 0 ))
    local idx
    for (( idx=start_idx; idx<total_events; idx++ )); do
      [[ $shown -ge $available_lines ]] && break
      local eline="${ACTIVITY_EVENTS[$idx]}"

      # Parse JSON event using python3 inline
      local parsed
      parsed=$(python3 - "$eline" <<'PYEOF' 2>/dev/null
import json, sys
try:
    e = json.loads(sys.argv[1])
    ts = e.get("timestamp", "")
    # Format timestamp to HH:MM:SS
    if ts:
        try:
            from datetime import datetime, timezone
            dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            time_str = dt.astimezone().strftime("%H:%M:%S")
        except Exception:
            time_str = ts[11:19] if len(ts) >= 19 else ts
    else:
        time_str = "??:??:??"
    etype = e.get("type", "")
    msg = e.get("message", "")
    step = e.get("step", "")
    print(f"{time_str}|{etype}|{msg}|{step}")
except Exception as ex:
    print(f"??:??:??|PARSE_ERROR|{sys.argv[1][:60]}|")
PYEOF
) || parsed="??:??:??|PARSE_ERROR||"

      local e_time e_type e_msg e_step
      IFS='|' read -r e_time e_type e_msg e_step <<< "$parsed"

      case "$e_type" in
        task_start|TASK_START)
          buf_line "  ${BLUE}▶${RESET} ${DIM}${e_time}${RESET}  ${BOLD}${WHITE}${e_msg:-task started}${RESET}"
          ;;
        agent_start|AGENT_START)
          local agent_label="${e_step:-${e_msg}}"
          buf_line "  ${YELLOW}▸${RESET} ${DIM}${e_time}${RESET}  ${YELLOW}${agent_label}${RESET}  ${DIM}starting${RESET}"
          ;;
        agent_done|AGENT_DONE)
          local agent_label="${e_step:-${e_msg}}"
          buf_line "  ${GREEN}✓${RESET} ${DIM}${e_time}${RESET}  ${CYAN}${agent_label}${RESET}  ${DIM}done${RESET}"
          ;;
        agent_fail|AGENT_FAIL)
          local agent_label="${e_step:-${e_msg}}"
          buf_line "  ${RED}✗${RESET} ${DIM}${e_time}${RESET}  ${RED}${agent_label}${RESET}  ${DIM}failed${RESET}"
          ;;
        task_done|TASK_DONE)
          buf_line "  ${GREEN}■${RESET} ${DIM}${e_time}${RESET}  ${GREEN}${BOLD}DONE${RESET}  ${DIM}${e_msg}${RESET}"
          ;;
        task_fail|TASK_FAIL)
          buf_line "  ${RED}■${RESET} ${DIM}${e_time}${RESET}  ${RED}${BOLD}FAIL${RESET}  ${DIM}${e_msg}${RESET}"
          ;;
        step_start|STEP_START)
          buf_line "  ${MAGENTA}◆${RESET} ${DIM}${e_time}${RESET}  ${MAGENTA}${e_step:-step}${RESET}  ${DIM}${e_msg}${RESET}"
          ;;
        step_done|STEP_DONE)
          buf_line "  ${GREEN}◆${RESET} ${DIM}${e_time}${RESET}  ${CYAN}${e_step:-step}${RESET}  ${DIM}${e_msg}${RESET}"
          ;;
        PARSE_ERROR)
          buf_line "  ${DIM}${e_time}  [parse error] ${e_msg}${RESET}"
          ;;
        *)
          if [[ -n "$e_msg" ]]; then
            buf_line "  ${DIM}${e_time}  ${e_type}  ${e_msg}${RESET}"
          else
            buf_line "  ${DIM}${e_time}  ${e_type}${RESET}"
          fi
          ;;
      esac
      (( shown++ ))
    done
  fi

  # Fill remaining lines
  while [[ $shown -lt $((available_lines - 2)) ]]; do
    buf_line ""
    (( shown++ ))
  done

  buf_line "  ${DIM}←/→ tabs  [s] start  [k] stop  [q] quit  (auto-refresh ${REFRESH_INTERVAL}s)${RESET}"
  buf_flush
}

# ── Actions ───────────────────────────────────────────────────────────
action_start() {
  if foundry_is_batch_running; then
    ACTION_MSG="${YELLOW}Workers already running${RESET}"; return
  fi
  local pending_count=$CACHED_PENDING_COUNT
  if [[ $pending_count -eq 0 ]]; then
    ACTION_MSG="${YELLOW}No pending tasks${RESET}"; return
  fi
  nohup "$REPO_ROOT/agentic-development/foundry.sh" headless \
    > /dev/null 2>&1 &
  ACTION_MSG="${GREEN}Started headless workers ($pending_count pending tasks, PID $!)${RESET}"
  invalidate_cache
}

action_retry_failed() {
  if foundry_is_batch_running; then
    ACTION_MSG="${RED}Workers running — stop first (k)${RESET}"; return
  fi
  "$REPO_ROOT/agentic-development/foundry.sh" retry > /dev/null 2>&1 &
  ACTION_MSG="${GREEN}Retrying failed tasks…${RESET}"
  invalidate_cache
}

action_kill() {
  if ! foundry_is_batch_running; then
    ACTION_MSG="${YELLOW}No workers running${RESET}"; return
  fi
  "$REPO_ROOT/agentic-development/foundry.sh" stop
  ACTION_MSG="${RED}Stopped workers${RESET}"
  invalidate_cache
}

action_resume_task() {
  [[ $ALL_TASKS_COUNT -eq 0 || $SELECTED_IDX -ge $ALL_TASKS_COUNT ]] && return
  local state="${ALL_TASKS_STATES[$SELECTED_IDX]%%:*}"
  [[ "$state" != "suspended" ]] && { ACTION_MSG="${YELLOW}Can only resume suspended tasks${RESET}"; return; }
  local task_dir="${ALL_TASKS_DIRS[$SELECTED_IDX]}" title="${ALL_TASKS_TITLES[$SELECTED_IDX]}"
  foundry_set_state_status "$task_dir" "pending" "" ""
  ACTION_MSG="${GREEN}Resumed: ${title} → pending${RESET}"
  invalidate_cache
}

action_resume_all_suspended() {
  local count=0
  local task_dir status
  while IFS= read -r task_dir; do
    [[ -d "$task_dir" ]] || continue
    status=$(foundry_state_field "$task_dir" status 2>/dev/null || echo "pending")
    if [[ "$status" == "suspended" ]]; then
      foundry_set_state_status "$task_dir" "pending" "" ""
      count=$((count + 1))
    fi
  done < <(foundry_list_task_dirs)
  [[ $count -eq 0 ]] && { ACTION_MSG="${YELLOW}No suspended tasks to resume${RESET}"; return; }
  ACTION_MSG="${GREEN}Resumed $count suspended → pending${RESET}"
  invalidate_cache
}

action_delete() {
  [[ $ALL_TASKS_COUNT -eq 0 || $SELECTED_IDX -ge $ALL_TASKS_COUNT ]] && return
  local state="${ALL_TASKS_STATES[$SELECTED_IDX]%%:*}"
  [[ "$state" != "pending" && "$state" != "failed" && "$state" != "suspended" ]] && {
    ACTION_MSG="${YELLOW}Can only delete pending, failed, or suspended tasks${RESET}"; return
  }
  local task_dir="${ALL_TASKS_DIRS[$SELECTED_IDX]}" title="${ALL_TASKS_TITLES[$SELECTED_IDX]}"
  rm -rf "$task_dir"
  ACTION_MSG="${RED}Deleted: ${title}${RESET}"
  invalidate_cache
}

action_promote() {
  [[ $ALL_TASKS_COUNT -eq 0 || $SELECTED_IDX -ge $ALL_TASKS_COUNT ]] && return
  [[ "${ALL_TASKS_STATES[$SELECTED_IDX]%%:*}" != "pending" ]] && {
    ACTION_MSG="${YELLOW}Can only change priority of pending tasks${RESET}"; return
  }
  local task_dir="${ALL_TASKS_DIRS[$SELECTED_IDX]}"
  local prio; prio=$(get_priority "$task_dir")
  set_priority "$task_dir" "$((prio + 1))"
  ACTION_MSG="${MAGENTA}Priority → #$((prio + 1))${RESET}"
  invalidate_cache
}

action_demote() {
  [[ $ALL_TASKS_COUNT -eq 0 || $SELECTED_IDX -ge $ALL_TASKS_COUNT ]] && return
  [[ "${ALL_TASKS_STATES[$SELECTED_IDX]%%:*}" != "pending" ]] && {
    ACTION_MSG="${YELLOW}Can only change priority of pending tasks${RESET}"; return
  }
  local task_dir="${ALL_TASKS_DIRS[$SELECTED_IDX]}"
  local prio; prio=$(get_priority "$task_dir")
  local new=$((prio > 1 ? prio - 1 : 1))
  set_priority "$task_dir" "$new"
  ACTION_MSG="${MAGENTA}Priority → #${new}${RESET}"
  invalidate_cache
}

action_view_task() {
  [[ $ALL_TASKS_COUNT -eq 0 || $SELECTED_IDX -ge $ALL_TASKS_COUNT ]] && return
  local task_dir="${ALL_TASKS_DIRS[$SELECTED_IDX]}"
  local task_file="$task_dir/task.md"
  if [[ -f "$task_file" ]]; then
    LOG_VIEW_FILE="$task_file"
    LOG_VIEW_MODE=true
  else
    ACTION_MSG="${YELLOW}No task.md found${RESET}"
  fi
}

# ── Auto-start logic ─────────────────────────────────────────────────
autostart_check() {
  [[ "$AUTOSTART" != "true" ]] && return
  local now; now=$(date +%s)
  (( now - AUTOSTART_LAST < AUTOSTART_COOLDOWN )) && return

  [[ $CACHED_PENDING_COUNT -eq 0 ]] && return
  foundry_is_batch_running && return

  AUTOSTART_LAST=$now
  nohup "$REPO_ROOT/agentic-development/foundry.sh" headless \
    > /dev/null 2>&1 &
  ACTION_MSG="${GREEN}Auto-started workers ($CACHED_PENDING_COUNT pending tasks, PID $!)${RESET}"
  invalidate_cache
}

# ── Main render dispatch ──────────────────────────────────────────────
render() {
  if [[ $CURRENT_TAB -eq 1 ]]; then
    render_overview
  else
    render_logs_tab
  fi
}

# ── Input handling ────────────────────────────────────────────────────
LAST_KEY=""

read_key() {
  LAST_KEY="_timeout_"
  local key=""
  if ! IFS= read -rsn1 -t "$REFRESH_INTERVAL" key 2>/dev/null; then
    return  # timeout — no key pressed
  fi

  if [[ "$key" == $'\x1b' ]]; then
    local seq=""
    seq=$(dd bs=2 count=1 2>/dev/null < /dev/stdin) || true
    case "$seq" in
      "[A") LAST_KEY="UP" ;;
      "[B") LAST_KEY="DOWN" ;;
      "[C") LAST_KEY="RIGHT" ;;
      "[D") LAST_KEY="LEFT" ;;
      *)    LAST_KEY="ESC" ;;
    esac
  elif [[ -z "$key" || "$key" == $'\r' || "$key" == $'\n' ]]; then
    LAST_KEY="ENTER"
  else
    LAST_KEY="$key"
  fi
}

# ── Main loop ─────────────────────────────────────────────────────────
main() {
  # Alternate screen buffer
  printf '\033[?1049h'
  tput civis 2>/dev/null || true

  # Raw terminal mode
  ORIG_STTY=$(stty -g 2>/dev/null || true)
  stty -echo -icanon 2>/dev/null || true

  cleanup() {
    stty "$ORIG_STTY" 2>/dev/null || true
    tput cnorm 2>/dev/null || true
    printf '\033[?1049l'
  }
  trap 'cleanup; exit 0' EXIT INT TERM

  # One-time startup tasks
  cleanup_old_logs

  while true; do
    render
    autostart_check
    RENDER_CYCLE=$((RENDER_CYCLE + 1))
    FORCE_REBUILD=false
    read_key

    case "$LAST_KEY" in
      q|Q)
        if [[ "$LOG_VIEW_MODE" == true ]]; then
          LOG_VIEW_MODE=false; LOG_VIEW_FILE=""
        elif [[ "$DETAIL_MODE" == true ]]; then
          DETAIL_MODE=false; DETAIL_FILE=""
        else
          exit 0
        fi ;;
      r|R)        invalidate_cache; continue ;;
      s|S)        action_start; invalidate_cache ;;
      f|F)        action_retry_failed; invalidate_cache ;;
      k|K)        action_kill; invalidate_cache ;;
      +)          action_promote; invalidate_cache ;;
      -)          action_demote; invalidate_cache ;;
      d|D)        action_delete; invalidate_cache ;;
      u)          action_resume_task; invalidate_cache ;;
      U)          action_resume_all_suspended; invalidate_cache ;;
      l|L)
        if [[ $CURRENT_TAB -eq 1 && $ALL_TASKS_COUNT -gt 0 && $SELECTED_IDX -lt $ALL_TASKS_COUNT ]]; then
          action_view_task
        fi ;;
      UP)
        [[ $SELECTED_IDX -gt 0 ]] && SELECTED_IDX=$((SELECTED_IDX - 1))
        DETAIL_MODE=false; LOG_VIEW_MODE=false ;;
      DOWN)
        [[ $SELECTED_IDX -lt $((ALL_TASKS_COUNT - 1)) ]] && SELECTED_IDX=$((SELECTED_IDX + 1))
        DETAIL_MODE=false; LOG_VIEW_MODE=false ;;
      LEFT)
        CURRENT_TAB=$(( CURRENT_TAB > 1 ? CURRENT_TAB - 1 : MAX_TABS ))
        DETAIL_MODE=false; LOG_VIEW_MODE=false ;;
      RIGHT)
        CURRENT_TAB=$(( CURRENT_TAB < MAX_TABS ? CURRENT_TAB + 1 : 1 ))
        DETAIL_MODE=false; LOG_VIEW_MODE=false ;;
      ESC|$'\x7f')
        DETAIL_MODE=false; DETAIL_FILE=""
        LOG_VIEW_MODE=false; LOG_VIEW_FILE="" ;;
      ENTER)
        if [[ $CURRENT_TAB -eq 1 && $ALL_TASKS_COUNT -gt 0 && $SELECTED_IDX -lt $ALL_TASKS_COUNT ]]; then
          DETAIL_MODE=true
          DETAIL_FILE="${ALL_TASKS_DIRS[$SELECTED_IDX]}/task.md"
        fi ;;
      [1-2])
        CURRENT_TAB=$LAST_KEY; DETAIL_MODE=false ;;
    esac
  done
}

main
