#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/agentic-development/lib/foundry-common.sh"
ensure_runtime_root
auto_cleanup

LOG_FILE="$(runtime_log_file ultraworks)"

show_help() {
  cat <<'EOF'
Ultraworks runtime

Usage:
  ./agentic-development/ultraworks.sh
  ./agentic-development/ultraworks.sh <command> [args...]

Commands:
  monitor              Open the interactive TUI monitor (default)
  status               Show current Ultraworks state
  launch [task]        Start Ultraworks in tmux
  headless <task>      Run Ultraworks headless
  attach               Attach to latest tracked tmux session
  logs [pattern]       View latest or matching log
  cleanup [args]       Cleanup old worktrees and artifacts
  env-check [args]     Run environment checks
  list                 Show available commands
EOF
}

run_tui() {
  local monitor_dir="$REPO_ROOT/agentic-development/monitor"
  if [[ -f "$monitor_dir/dist/index.js" ]]; then
    exec node "$monitor_dir/dist/index.js" "$REPO_ROOT/tasks" "$@"
  else
    exec "$monitor_dir/node_modules/.bin/tsx" "$monitor_dir/src/index.tsx" "$REPO_ROOT/tasks" "$@"
  fi
}

run_command() {
  local cmd="${1:-monitor}"
  shift || true

  case "$cmd" in
    monitor)
      runtime_log ultraworks "command=monitor args=$*"
      run_tui "$@"
      ;;
    show|status)
      runtime_log ultraworks "command=status args=$*"
      foundry_task_counts | while IFS='=' read -r key value; do
        case "$key" in
          in_progress) echo "Running: ${value}" ;;
          waiting_answer) echo "Waiting: ${value}" ;;
          completed) echo "Completed: ${value}" ;;
          failed) echo "Failed: ${value}" ;;
        esac
      done
      echo ""
      echo "Task root: ${FOUNDRY_TASK_ROOT_REL}"
      echo "Log: ${LOG_FILE}"
      ;;
    launch|run)
      runtime_log ultraworks "command=launch args=$*"
      run_tui --launch "$*"
      ;;
    headless)
      runtime_log ultraworks "command=headless args=$*"
      if [[ $# -eq 0 ]]; then
        echo "Error: task description required for headless mode"
        echo "Usage: ./agentic-development/ultraworks.sh headless \"<task description>\""
        exit 1
      fi
      local task="$*"
      local slug
      slug=$(pipeline_slugify "$task")
      local task_dir
      task_dir=$(foundry_create_task_dir "$task" "$slug" 2>/dev/null || echo "$PIPELINE_TASKS_ROOT/${slug}--ultraworks")
      mkdir -p "$task_dir"
      echo "$task" > "$task_dir/task.md"
      foundry_set_state_status "$task_dir" "pending" "" ""
      pipeline_task_append_event "$task_dir" "task_created" "Ultraworks task created"
      echo "Created task: ${task_dir#$REPO_ROOT/}"
      echo "Run: opencode run --command auto \"$task\""
      opencode run --command auto "$task" || true
      ;;
    attach)
      runtime_log ultraworks "command=attach args=$*"
      local session
      session=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | grep -E '^ultraworks' | head -1 || true)
      if [[ -n "$session" ]]; then
        exec tmux attach -t "$session"
      else
        echo "No ultraworks tmux session found."
        echo "Start with: ./agentic-development/ultraworks.sh launch \"<task>\""
        exit 1
      fi
      ;;
    logs)
      runtime_log ultraworks "command=logs args=$*"
      local log_dir="$REPO_ROOT/agentic-development/runtime/logs"
      local pattern="${1:-ultraworks}"
      local latest
      latest=$(ls -t "$log_dir"/${pattern}*.log 2>/dev/null | head -1 || true)
      if [[ -n "$latest" ]]; then
        tail -f "$latest"
      else
        echo "No logs found matching: ${pattern}"
        ls -lt "$log_dir"/*.log 2>/dev/null | head -5 || echo "No logs in ${log_dir}"
      fi
      ;;
    cleanup)
      runtime_log ultraworks "command=cleanup args=$*"
      exec "$REPO_ROOT/agentic-development/lib/foundry-cleanup.sh" "$@"
      ;;
    env-check)
      runtime_log ultraworks "command=env-check args=$*"
      exec "$REPO_ROOT/agentic-development/lib/env-check.sh" "$@"
      ;;
    list)
      show_help
      ;;
    *)
      echo "Unknown Ultraworks command: $cmd" >&2
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
