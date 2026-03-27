#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/agentic-development/lib/foundry-common.sh"

maybe_migrate_legacy_foundry_tasks
ensure_foundry_task_root
ensure_runtime_root
auto_cleanup

LOG_FILE="$(runtime_log_file foundry-headless)"

show_help() {
  cat <<EOF
Foundry runtime

Usage:
  ./agentic-development/foundry.sh
  ./agentic-development/foundry.sh headless
  ./agentic-development/foundry.sh command <name> [args...]
  ./agentic-development/foundry.sh <command> [args...]

Commands:
  monitor              Open the interactive Foundry monitor (default)
  headless             Start background queue processing for ${FOUNDRY_TASK_ROOT_REL}
  e2e-autofix [args]   Run E2E tests, create Foundry fix tasks for failures
  autotest [args]      Alias for e2e-autofix, optimized for daily E2E -> task flow
  run [runtime args]   Run a single sequential Foundry task
  batch [args]         Consume pending Foundry task directories from ${FOUNDRY_TASK_ROOT_REL}
  retry [args]         Retry failed Foundry tasks
  resume <slug>        Resume a stopped task (after fixing underlying issue)
  stats [args]         Show Foundry pipeline statistics
  cleanup [args]       Clean old runtime artifacts
  env-check [args]     Run environment checks
  setup                Initialize Foundry directories and optional monitor deps
  start                Alias for headless
  stop                 Stop running Foundry batch workers
  status               Show current Foundry worker status
  list                 List available top-level Foundry commands

Task pool:
  Foundry uses ${FOUNDRY_TASK_ROOT_REL}/<slug>--foundry/ as its queue/state store.
  A task is pending when task.md exists and state.json is missing or has status=pending.

Background mode:
  ./agentic-development/foundry.sh headless
  Starts lib/foundry-batch.sh in watch mode and writes to:
    ${LOG_FILE}
    $(runtime_log_file foundry)

Concurrency:
  Workers run in parallel using git worktrees (.pipeline-worktrees/worker-N).
  Each worker atomically claims a pending task, runs it in an isolated worktree,
  and returns results to the shared task directory.
  Adjust worker count: monitor []/[] keys, or FOUNDRY_WORKERS env var.

Examples:
  ./agentic-development/foundry.sh                              # open TUI monitor
  ./agentic-development/foundry.sh status                       # show task counts
  ./agentic-development/foundry.sh run --task-file task.md      # run single task
  ./agentic-development/foundry.sh batch --watch --workers 3    # 3 parallel workers
  FOUNDRY_WORKERS=2 ./agentic-development/foundry.sh headless   # headless mode
EOF
}

foundry_preflight_check() {
  local failures=()
  local warnings=()
  local script
  local scripts=(
    "$REPO_ROOT/agentic-development/foundry.sh"
    "$REPO_ROOT/agentic-development/lib/foundry-batch.sh"
    "$REPO_ROOT/agentic-development/lib/foundry-run.sh"
  )

  for script in "${scripts[@]}"; do
    if ! bash -n "$script" 2>/dev/null; then
      failures+=("shell syntax check failed: ${script#"$REPO_ROOT"/}")
    fi
  done

  if [[ -x "$REPO_ROOT/agentic-development/lib/env-check.sh" ]]; then
    local env_output="" env_exit=0
    env_output=$("$REPO_ROOT/agentic-development/lib/env-check.sh" --quiet --report-file "$REPO_ROOT/.opencode/pipeline/env-report.json" 2>&1) || env_exit=$?
    case "$env_exit" in
      0) ;;
      1) warnings+=("environment has warnings") ;;
      *) failures+=("environment check failed") ;;
    esac
    [[ -n "$env_output" ]] && runtime_log foundry "preflight env-check output: $env_output"
  fi

  local pending_count=0
  while IFS='=' read -r key value; do
    [[ "$key" == "pending" ]] && pending_count="$value"
  done < <(foundry_task_counts)
  [[ "$pending_count" -eq 0 ]] && warnings+=("no pending tasks")

  local message=""
  if [[ ${#failures[@]} -gt 0 ]]; then
    message="Preflight failed: ${failures[*]}"
    runtime_log foundry "$message"
    printf '%s\n' "$message" >&2
    return 1
  fi

  if [[ ${#warnings[@]} -gt 0 ]]; then
    message="Preflight warnings: ${warnings[*]}"
    runtime_log foundry "$message"
  else
    runtime_log foundry "preflight ok"
  fi
  return 0
}

foundry_start_headless() {
  local desired_workers
  desired_workers=$(foundry_get_desired_workers)

  if foundry_is_batch_running; then
    runtime_log foundry "headless already running"
    echo "Foundry headless is already running."
    return 0
  fi

  if ! foundry_preflight_check; then
    echo "Foundry headless start blocked by preflight checks."
    return 1
  fi

  local _caff=""
  command -v caffeinate &>/dev/null && _caff="caffeinate -s"
  $_caff nohup "$REPO_ROOT/agentic-development/lib/foundry-batch.sh" \
    --workers "$desired_workers" \
    --no-stop-on-failure \
    --watch \
    > "$LOG_FILE" 2>&1 &

  runtime_log foundry "headless started pid=$! workers=${desired_workers} log=${LOG_FILE}"
  echo "Foundry headless started (PID $!, workers=${desired_workers})."
  echo "Monitor: ./agentic-development/foundry.sh"
}

foundry_stop_headless() {
  if ! foundry_is_batch_running; then
    runtime_log foundry "stop requested but no workers running"
    echo "No running Foundry batch workers."
    return 0
  fi
  pkill -f 'agentic-development/lib/foundry-batch\.sh' 2>/dev/null || true
  pkill -f 'foundry-batch\.sh' 2>/dev/null || true
  runtime_log foundry "headless workers stopped"
  foundry_cancel_in_progress_tasks
  echo "Foundry headless workers stopped."
}

foundry_status() {
  local pending=0 in_progress=0 completed=0 failed=0 suspended=0 cancelled=0
  while IFS='=' read -r key value; do
    case "$key" in
      pending) pending="$value" ;;
      in_progress) in_progress="$value" ;;
      completed) completed="$value" ;;
      failed) failed="$value" ;;
      suspended) suspended="$value" ;;
      cancelled) cancelled="$value" ;;
    esac
  done < <(foundry_task_counts)

  echo "Foundry root: ${FOUNDRY_TASK_ROOT_REL}"
  if foundry_is_batch_running; then
    echo "Status: running"
  else
    echo "Status: idle"
  fi
  echo "Pending: ${pending}"
  echo "In progress: ${in_progress}"
  echo "Completed: ${completed}"
  echo "Failed: ${failed}"
  echo "Suspended: ${suspended}"
  echo "Cancelled: ${cancelled}"
  echo "Desired workers: $(foundry_get_desired_workers)"

  # Show blacklisted models if any
  local blacklist_file="${REPO_ROOT}/.opencode/pipeline/.model-blacklist.json"
  if [[ -f "$blacklist_file" ]]; then
    local now
    now=$(date +%s)
    local blacklisted_models
    blacklisted_models=$(jq -r --argjson now "$now" \
      'to_entries | map(select(.value > $now) | .key) | join(", ")' \
      "$blacklist_file" 2>/dev/null || echo "")
    if [[ -n "$blacklisted_models" ]]; then
      echo "Blacklisted models: ${blacklisted_models}"
    fi
  fi

  echo "Log: ${LOG_FILE}"
  runtime_log foundry "status pending=${pending} in_progress=${in_progress} completed=${completed} failed=${failed}"
}

run_command() {
  local cmd="${1:-monitor}"
  shift || true

  case "$cmd" in
    monitor)
      runtime_log foundry "command=monitor"
      # Auto-start headless workers if not running and there are pending tasks
      if ! foundry_is_batch_running && [[ -n "$(foundry_find_tasks_by_status pending 2>/dev/null | head -1)" ]]; then
        foundry_start_headless 2>/dev/null
      fi
      local monitor_dir="$REPO_ROOT/agentic-development/monitor"
      if [[ -f "$monitor_dir/dist/index.js" ]]; then
        exec node "$monitor_dir/dist/index.js" "$FOUNDRY_TASK_ROOT"
      else
        exec "$monitor_dir/node_modules/.bin/tsx" "$monitor_dir/src/index.tsx" "$FOUNDRY_TASK_ROOT"
      fi
      ;;
    headless|start)
      foundry_start_headless "$@"
      ;;
    stop)
      foundry_stop_headless
      ;;
    status)
      foundry_status
      ;;
    resume)
      shift
      if [[ $# -eq 0 ]]; then
        echo "Error: task slug required"
        echo "Usage: ./agentic-development/foundry.sh resume <task-slug>"
        exit 1
      fi
      task_slug="$1"
      task_dir=$(foundry_task_dir_for_slug "$task_slug" 2>/dev/null || true)
      if [[ -z "$task_dir" ]]; then
        echo "Error: task not found: $task_slug"
        exit 1
      fi
      source "$REPO_ROOT/agentic-development/lib/foundry-preflight.sh"
      if foundry_resume_stopped_task "$task_dir"; then
        echo "✓ Task resumed: $task_slug"
        echo "  Status: $(foundry_state_field "$task_dir" status)"
        echo "  Run 'foundry.sh status' to see all tasks"
      else
        echo "✗ Failed to resume task: $task_slug"
        exit 1
      fi
      ;;
    run)
      runtime_log foundry "command=run args=$*"
      exec "$REPO_ROOT/agentic-development/lib/foundry-run.sh" "$@"
      ;;
    batch)
      runtime_log foundry "command=batch args=$*"
      exec "$REPO_ROOT/agentic-development/lib/foundry-batch.sh" "$@"
      ;;
    retry)
      runtime_log foundry "command=retry args=$*"
      exec "$REPO_ROOT/agentic-development/lib/foundry-retry.sh" "$@"
      ;;
    stats)
      runtime_log foundry "command=stats args=$*"
      exec "$REPO_ROOT/agentic-development/lib/foundry-stats.sh" "$@"
      ;;
    cleanup)
      runtime_log foundry "command=cleanup args=$*"
      exec "$REPO_ROOT/agentic-development/lib/foundry-cleanup.sh" "$@"
      ;;
    env-check)
      runtime_log foundry "command=env-check args=$*"
      exec "$REPO_ROOT/agentic-development/lib/env-check.sh" "$@"
      ;;
    setup)
      runtime_log foundry "command=setup"
      exec "$REPO_ROOT/agentic-development/lib/foundry-setup.sh" "$@"
      ;;
    e2e-autofix|autotest)
      runtime_log foundry "command=$cmd args=$*"
      exec "$REPO_ROOT/agentic-development/lib/foundry-e2e.sh" "$@"
      ;;
    list)
      show_help
      ;;
    *)
      echo "Unknown Foundry command: $cmd" >&2
      echo "" >&2
      show_help >&2
      exit 1
      ;;
  esac
}

if [[ $# -eq 0 ]]; then
  run_command monitor
fi

if [[ "${1:-}" == "command" ]]; then
  shift
fi

run_command "$@"
