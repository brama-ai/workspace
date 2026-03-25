#!/usr/bin/env bash
#
# Foundry batch runner with parallel worker support.
# Each worker gets its own git worktree and claims tasks atomically.

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

# ── Colors ────────────────────────────────────────────────────────────
NC=$'\033[0m'
GREEN=$'\033[0;32m'
RED=$'\033[0;31m'
YELLOW=$'\033[1;33m'
CYAN=$'\033[0;36m'
DIM=$'\033[2m'

show_help() {
  cat <<EOF
Foundry batch runner (parallel workers)

Usage:
  ./agentic-development/foundry.sh batch [tasks-root]

Options:
  --watch               Keep polling for pending Foundry tasks
  --watch-interval N    Poll interval in seconds (default: 15)
  --workers N           Number of parallel workers (default: 1)
  --no-stop-on-failure  Continue after a failed task
  -h, --help            Show this help

Task root defaults to: ${FOUNDRY_TASK_ROOT_REL}
EOF
}

acquire_lock() {
  mkdir -p "$(dirname "$LOCKFILE")"
  if [[ -f "$LOCKFILE" ]]; then
    local old_pid
    old_pid=$(cat "$LOCKFILE" 2>/dev/null || true)
    if [[ -n "$old_pid" ]]; then
      # Check if PID is alive AND not a zombie
      local pid_stat
      pid_stat=$(cat "/proc/${old_pid}/status" 2>/dev/null | awk '/^State:/{print $2}' || true)
      if [[ -n "$pid_stat" ]] && [[ "$pid_stat" != "Z" ]]; then
        echo "Another Foundry batch is already running (PID $old_pid)." >&2
        exit 1
      fi
      # PID is dead or zombie — clean stale lock
      if [[ "$pid_stat" == "Z" ]]; then
        echo "${YELLOW}[cleanup]${NC} Removed stale lock from zombie PID $old_pid" >&2
      fi
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
  echo "Foundry batch reads tasks from ${FOUNDRY_TASK_ROOT_REL}." >&2
fi

mkdir -p "$REPO_ROOT/.opencode/pipeline/logs" "$REPO_ROOT/.opencode/pipeline/reports"
acquire_lock
trap 'cleanup_all; release_lock' EXIT

# ── Worker PID tracking ──────────────────────────────────────────────
declare -A WORKER_PIDS=()      # worker_id -> PID
declare -A WORKER_TASKS=()     # worker_id -> task_dir
BATCH_FAILED=false

log_batch() {
  local ts
  ts=$(date '+%H:%M:%S')
  echo -e "${DIM}[${ts}]${NC} $*"
}

# ── Single worker loop ───────────────────────────────────────────────
# Runs in a subshell; claims tasks, runs them in a worktree, loops.
worker_loop() {
  local worker_id="$1"
  shift
  local extra_args=("$@")

  while true; do
    # Claim the next pending task
    local task_dir
    task_dir=$(foundry_claim_next_task "$worker_id" 2>/dev/null) || break

    local task_name
    task_name=$(basename "$task_dir")
    log_batch "${CYAN}${worker_id}${NC} claimed: ${task_name}"

    local task_file
    task_file=$(foundry_task_file "$task_dir")
    [[ -f "$task_file" ]] || continue

    local exit_code=0

    if [[ "$WORKERS" -gt 1 ]]; then
      # Multi-worker: run inside a git worktree
      local wt_path
      wt_path=$(foundry_create_worktree "$worker_id") || {
        log_batch "${RED}${worker_id}${NC} failed to create worktree"
        foundry_release_task "$task_dir"
        continue
      }

      # Run foundry-run.sh inside the worktree
      PIPELINE_REPO_ROOT="$wt_path" \
      PIPELINE_TASKS_ROOT="$PIPELINE_TASKS_ROOT" \
      PIPELINE_WORKER_ID="$worker_id" \
        "$REPO_ROOT/agentic-development/lib/foundry-run.sh" \
        --task-file "$task_file" "${extra_args[@]+"${extra_args[@]}"}" || exit_code=$?
    else
      # Single worker: run in-place (no worktree overhead)
      PIPELINE_WORKER_ID="$worker_id" \
        "$REPO_ROOT/agentic-development/lib/foundry-run.sh" \
        --task-file "$task_file" "${extra_args[@]+"${extra_args[@]}"}" || exit_code=$?
    fi

    if [[ $exit_code -ne 0 ]]; then
      log_batch "${RED}${worker_id}${NC} task failed: ${task_name} (exit $exit_code)"
      if [[ "$STOP_ON_FAILURE" == true ]]; then
        return 1
      fi
      # BUG-FIX: after a failure, release the task back to pending so it can
      # be retried, then STOP the worker loop — do NOT immediately claim the
      # next task. One failure = one stop. The watch loop will respawn the
      # worker on the next interval, giving time for transient errors to clear
      # (git lock contention, rate limits, etc.).
      foundry_release_task "$task_dir" 2>/dev/null || true
      return 0
    else
      log_batch "${GREEN}${worker_id}${NC} task done: ${task_name}"
    fi
  done

  return 0
}

# ── Cleanup ──────────────────────────────────────────────────────────
cleanup_all() {
  # Kill all worker subprocesses
  for wid in "${!WORKER_PIDS[@]}"; do
    local pid="${WORKER_PIDS[$wid]}"
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
  WORKER_PIDS=()
  # Cancel orphaned in_progress tasks
  foundry_cancel_in_progress_tasks
}

# ── Spawn workers ────────────────────────────────────────────────────
spawn_workers() {
  local num_workers="$1"
  shift
  local extra_args=("$@")

  for ((i=1; i<=num_workers; i++)); do
    local wid="worker-${i}"

    # Skip if already running
    if [[ -n "${WORKER_PIDS[$wid]:-}" ]] && kill -0 "${WORKER_PIDS[$wid]}" 2>/dev/null; then
      continue
    fi

    worker_loop "$wid" "${extra_args[@]+"${extra_args[@]}"}" &
    WORKER_PIDS[$wid]=$!
    log_batch "Spawned ${CYAN}${wid}${NC} (PID ${WORKER_PIDS[$wid]})"
  done
}

# ── Wait for all workers to finish ────────────────────────────────────
wait_for_workers() {
  local any_failed=false
  for wid in "${!WORKER_PIDS[@]}"; do
    local pid="${WORKER_PIDS[$wid]}"
    if ! wait "$pid" 2>/dev/null; then
      any_failed=true
      log_batch "${RED}${wid}${NC} exited with failure"
    else
      log_batch "${GREEN}${wid}${NC} finished"
    fi
    unset "WORKER_PIDS[$wid]"
  done
  [[ "$any_failed" == true ]] && return 1
  return 0
}

# ── Check if any worker is still alive ────────────────────────────────
any_worker_alive() {
  for wid in "${!WORKER_PIDS[@]}"; do
    if kill -0 "${WORKER_PIDS[$wid]}" 2>/dev/null; then
      return 0
    fi
  done
  return 1
}

# ── Main execution ───────────────────────────────────────────────────
log_batch "Foundry batch starting (workers=${WORKERS}, watch=${WATCH_MODE})"

if [[ "$WATCH_MODE" == true ]]; then
  log_batch "Watch mode active on ${FOUNDRY_TASK_ROOT_REL} (interval=${WATCH_INTERVAL}s)"
  desired=""
  pid=""
  active_count=0
  to_kill=0
  while true; do
    # Check desired worker count (can be changed at runtime via monitor)
    desired=$(foundry_get_desired_workers 2>/dev/null || echo "$WORKERS")
    WORKERS="$desired"

    # Spawn/respawn workers up to desired count
    spawn_workers "$WORKERS" "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"

    # Reap finished workers
    for wid in "${!WORKER_PIDS[@]}"; do
      pid="${WORKER_PIDS[$wid]}"
      if ! kill -0 "$pid" 2>/dev/null; then
        wait "$pid" 2>/dev/null || true
        unset "WORKER_PIDS[$wid]"
      fi
    done

    # Scale down: kill extra workers if desired count decreased
    active_count=0
    for _ in "${!WORKER_PIDS[@]}"; do
      active_count=$((active_count + 1))
    done
    if [[ $active_count -gt $WORKERS ]]; then
      to_kill=$((active_count - WORKERS))
      for wid in "${!WORKER_PIDS[@]}"; do
        [[ $to_kill -le 0 ]] && break
        pid="${WORKER_PIDS[$wid]}"
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
        unset "WORKER_PIDS[$wid]"
        log_batch "Scaled down ${CYAN}${wid}${NC}"
        to_kill=$((to_kill - 1))
      done
    fi

    sleep "$WATCH_INTERVAL"
  done
else
  # Non-watch mode: spawn workers, wait for all to finish
  spawn_workers "$WORKERS" "${EXTRA_ARGS[@]+"${EXTRA_ARGS[@]}"}"
  wait_for_workers || BATCH_FAILED=true

  if [[ "$BATCH_FAILED" == true ]]; then
    log_batch "${RED}Batch completed with failures${NC}"
    exit 1
  else
    log_batch "${GREEN}Batch completed successfully${NC}"
  fi
fi
