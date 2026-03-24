#!/usr/bin/env bash
#
# Foundry batch runner on top of task-centric state in tasks/*--foundry/.

set -euo pipefail

REPO_ROOT="${PIPELINE_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
# shellcheck source=/dev/null
source "$REPO_ROOT/agentic-development/lib/foundry-common.sh"

maybe_migrate_legacy_foundry_tasks
ensure_foundry_task_root

LOCKFILE="$REPO_ROOT/.opencode/pipeline/.batch.lock"
WATCH_MODE=false
WATCH_INTERVAL=15
STOP_ON_FAILURE=true
WORKERS=1
TASK_SOURCE=""
EXTRA_ARGS=()

show_help() {
  cat <<EOF
Foundry batch runner

Usage:
  ./agentic-development/foundry.sh batch [tasks-root]

Options:
  --watch               Keep polling for pending Foundry tasks
  --watch-interval N    Poll interval in seconds (default: 15)
  --workers N           Accepted for compatibility; current runtime processes serially
  --no-stop-on-failure  Continue after a failed task

Task root defaults to: ${FOUNDRY_TASK_ROOT_REL}
EOF
}

acquire_lock() {
  mkdir -p "$(dirname "$LOCKFILE")"
  if [[ -f "$LOCKFILE" ]]; then
    local old_pid
    old_pid=$(cat "$LOCKFILE" 2>/dev/null || true)
    if [[ -n "$old_pid" ]] && kill -0 "$old_pid" 2>/dev/null; then
      echo "Another Foundry batch is already running (PID $old_pid)." >&2
      exit 1
    fi
    rm -f "$LOCKFILE"
  fi
  echo "$$" > "$LOCKFILE"
}

release_lock() {
  rm -f "$LOCKFILE"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --watch) WATCH_MODE=true; shift ;;
    --watch-interval) WATCH_INTERVAL="$2"; shift 2 ;;
    --workers) WORKERS="$2"; shift 2 ;;
    --no-stop-on-failure) STOP_ON_FAILURE=false; shift ;;
    --help|-h) show_help; exit 0 ;;
    --*) EXTRA_ARGS+=("$1"); shift ;;
    *)
      if [[ -z "$TASK_SOURCE" ]]; then
        TASK_SOURCE="$1"
      else
        EXTRA_ARGS+=("$1")
      fi
      shift
      ;;
  esac
done

if [[ -n "$TASK_SOURCE" && "$TASK_SOURCE" != "$FOUNDRY_TASK_ROOT" ]]; then
  echo "Foundry batch now always reads task directories from ${FOUNDRY_TASK_ROOT_REL}." >&2
fi

mkdir -p "$REPO_ROOT/.opencode/pipeline/logs" "$REPO_ROOT/.opencode/pipeline/reports"
acquire_lock
trap 'release_lock' EXIT

run_one_task() {
  local task_dir="$1"
  local task_file
  task_file=$(foundry_task_file "$task_dir")
  [[ -f "$task_file" ]] || return 0

  echo ""
  echo "==> Running $(basename "$task_dir")"
  if "$REPO_ROOT/agentic-development/lib/foundry-run.sh" --task-file "$task_file" "${EXTRA_ARGS[@]}"; then
    return 0
  fi
  return 1
}

run_pending_tasks_once() {
  local ran_any=false
  local task_dir
  while IFS= read -r task_dir; do
    [[ -n "$task_dir" ]] || continue
    ran_any=true
    if ! run_one_task "$task_dir"; then
      if [[ "$STOP_ON_FAILURE" == true ]]; then
        return 1
      fi
    fi
  done < <(foundry_find_tasks_by_status "pending")

  if [[ "$ran_any" == false ]]; then
    echo "No pending Foundry tasks."
  fi
}

if [[ "$WORKERS" != "1" ]]; then
  echo "Foundry batch currently processes serially; ignoring --workers=$WORKERS."
fi

if [[ "$WATCH_MODE" == true ]]; then
  echo "Watch mode active on ${FOUNDRY_TASK_ROOT_REL}."
  while true; do
    run_pending_tasks_once || true
    sleep "$WATCH_INTERVAL"
  done
else
  run_pending_tasks_once
fi
