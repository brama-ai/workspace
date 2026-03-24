#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/agentic-development/lib/foundry-common.sh"
ensure_runtime_root
auto_cleanup

show_help() {
  cat <<'EOF'
Ultraworks runtime

Usage:
  ./agentic-development/ultraworks.sh
  ./agentic-development/ultraworks.sh <command> [args...]
  ./agentic-development/ultraworks.sh command <name> [args...]

Commands:
  monitor [args]       Open the interactive Ultraworks monitor (default)
  watch [args]         Open live TUI monitor
  launch [task]        Start Ultraworks in tmux
  headless <task>      Run Ultraworks headless
  status               Show current Ultraworks state
  attach               Attach to latest tracked tmux session
  logs [pattern]       View latest or matching log
  menu                 Open interactive menu
  env-check [args]     Run env-check.sh
  cleanup [args]       Run cleanup.sh
  list                 Show available commands
EOF
}

run_command() {
  local cmd="${1:-monitor}"
  shift || true

  case "$cmd" in
    monitor)
      runtime_log ultraworks "command=monitor args=$*"
      exec "$REPO_ROOT/agentic-development/lib/ultraworks-monitor.sh" menu "$@"
      ;;
    show|status)
      runtime_log ultraworks "command=status args=$*"
      exec "$REPO_ROOT/agentic-development/lib/ultraworks-monitor.sh" show "$@"
      ;;
    watch)
      runtime_log ultraworks "command=watch args=$*"
      exec "$REPO_ROOT/agentic-development/lib/ultraworks-monitor.sh" watch "$@"
      ;;
    launch|run)
      runtime_log ultraworks "command=launch args=$*"
      exec "$REPO_ROOT/agentic-development/lib/ultraworks-monitor.sh" launch "$@"
      ;;
    headless)
      runtime_log ultraworks "command=headless args=$*"
      exec "$REPO_ROOT/agentic-development/lib/ultraworks-monitor.sh" headless "$@"
      ;;
    attach)
      runtime_log ultraworks "command=attach args=$*"
      exec "$REPO_ROOT/agentic-development/lib/ultraworks-monitor.sh" attach "$@"
      ;;
    logs)
      runtime_log ultraworks "command=logs args=$*"
      exec "$REPO_ROOT/agentic-development/lib/ultraworks-monitor.sh" logs "$@"
      ;;
    menu|interactive)
      runtime_log ultraworks "command=menu args=$*"
      exec "$REPO_ROOT/agentic-development/lib/ultraworks-monitor.sh" menu "$@"
      ;;
    env-check)
      runtime_log ultraworks "command=env-check args=$*"
      exec "$REPO_ROOT/agentic-development/lib/env-check.sh" "$@"
      ;;
    cleanup)
      runtime_log ultraworks "command=cleanup args=$*"
      exec "$REPO_ROOT/agentic-development/lib/foundry-cleanup.sh" "$@"
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
