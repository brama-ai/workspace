#!/usr/bin/env bash
#
# foundry.sh - Hybrid Bash/TypeScript entrypoint
# TypeScript CLI: ./foundry-ts (preferred for new commands)
# Bash fallback: lib/foundry-*.sh (legacy)
#
set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
SCRIPT_DIR="$REPO_ROOT/agentic-development"

export REPO_ROOT
export PIPELINE_TASKS_ROOT="${PIPELINE_TASKS_ROOT:-$REPO_ROOT/tasks}"

TS_CLI="$SCRIPT_DIR/foundry-ts"

show_help() {
  cat <<EOF
Foundry v2.0 - Hybrid Bash/TypeScript Pipeline

Usage:
  ./agentic-development/foundry.sh <command> [args]

Commands (TypeScript):
  run                 Run a pipeline task (TS)
  status [slug]       Show task status (TS)
  list                List all tasks (TS)
  counts              Count tasks by status (TS)
  preflight           Run preflight checks (TS)
  env-check [profile] Run environment checks (TS)
  resume <slug>       Resume a paused task (TS)
  checkpoint <slug>   Show checkpoint summary (TS)

Commands (Bash legacy):
  monitor             Open interactive TUI monitor
  headless            Start background queue processing
  batch [args]        Consume pending tasks in parallel
  retry [args]        Retry failed tasks
  stats [args]        Show pipeline statistics
  cleanup [args]      Clean old runtime artifacts
  setup               Initialize directories
  e2e-autofix         Run E2E tests, create fix tasks
  stop                Stop running batch workers

Task pool:
  tasks/<slug>--foundry/ as queue/state store

Examples:
  ./agentic-development/foundry.sh run "Add feature X"
  ./agentic-development/foundry.sh status
  ./agentic-development/foundry.sh monitor
  ./agentic-development/foundry.sh headless
EOF
}

run_command() {
  local cmd="${1:-monitor}"
  shift || true

  case "$cmd" in
    run|status|list|counts|preflight|env-check|resume|checkpoint)
      exec "$TS_CLI" "$cmd" "$@"
      ;;
    monitor)
      local monitor_dir="$SCRIPT_DIR/monitor"
      if [[ -f "$monitor_dir/dist/index.js" ]]; then
        exec node "$monitor_dir/dist/index.js" "$PIPELINE_TASKS_ROOT"
      else
        exec npx tsx "$monitor_dir/src/index.tsx" "$PIPELINE_TASKS_ROOT"
      fi
      ;;
    headless|start)
      source "$SCRIPT_DIR/lib/foundry-common.sh"
      ensure_foundry_task_root
      ensure_runtime_root
      
      local log_file="$SCRIPT_DIR/runtime/logs/foundry-headless.log"
      local desired_workers="${FOUNDRY_WORKERS:-2}"
      
      if pgrep -f 'foundry-batch\.sh' &>/dev/null; then
        echo "Foundry headless already running"
        exit 0
      fi
      
      nohup "$SCRIPT_DIR/lib/foundry-batch.sh" \
        --workers "$desired_workers" \
        --no-stop-on-failure \
        --watch \
        > "$log_file" 2>&1 &
      
      echo "Foundry headless started (PID $!, workers=$desired_workers)"
      echo "Log: $log_file"
      ;;
    stop)
      pkill -f 'foundry-batch\.sh' 2>/dev/null || true
      echo "Foundry headless workers stopped"
      ;;
    batch)
      exec "$SCRIPT_DIR/lib/foundry-batch.sh" "$@"
      ;;
    retry)
      exec "$SCRIPT_DIR/lib/foundry-retry.sh" "$@"
      ;;
    stats)
      exec "$SCRIPT_DIR/lib/foundry-stats.sh" "$@"
      ;;
    cleanup)
      exec "$SCRIPT_DIR/lib/foundry-cleanup.sh" "$@"
      ;;
    setup)
      exec "$SCRIPT_DIR/lib/foundry-setup.sh" "$@"
      ;;
    e2e-autofix|autotest)
      exec "$SCRIPT_DIR/lib/foundry-e2e.sh" "$@"
      ;;
    help|--help|-h)
      show_help
      ;;
    list)
      show_help
      ;;
    *)
      echo "Unknown command: $cmd" >&2
      show_help >&2
      exit 1
      ;;
  esac
}

if [[ $# -eq 0 ]]; then
  run_command monitor
fi

run_command "$@"
