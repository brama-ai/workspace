#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="${PIPELINE_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
# shellcheck source=/dev/null
source "$REPO_ROOT/agentic-development/lib/foundry-common.sh"

maybe_migrate_legacy_foundry_tasks
ensure_foundry_task_root

print_summary() {
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

  echo "Foundry monitor"
  echo "Root: ${FOUNDRY_TASK_ROOT_REL}"
  echo "Workers: $(if foundry_is_batch_running; then echo running; else echo idle; fi)"
  echo "Pending: $pending"
  echo "In progress: $in_progress"
  echo "Completed: $completed"
  echo "Failed: $failed"
  echo "Suspended: $suspended"
  echo "Cancelled: $cancelled"
  echo ""
}

print_tasks() {
  printf "%-48s %-12s %-8s %s\n" "Task" "Status" "Attempt" "Summary"
  printf "%-48s %-12s %-8s %s\n" "----" "------" "-------" "-------"
  while IFS= read -r task_dir; do
    [[ -n "$task_dir" ]] || continue
    status=$(foundry_state_field "$task_dir" status 2>/dev/null || echo "pending")
    attempt=$(foundry_state_field "$task_dir" attempt 2>/dev/null || echo "1")
    summary="no"
    [[ -s "$(foundry_summary_file "$task_dir")" ]] && summary="yes"
    printf "%-48s %-12s %-8s %s\n" "$(basename "$task_dir")" "$status" "$attempt" "$summary"
  done < <(foundry_list_task_dirs)
  echo ""
}

run_menu() {
  while true; do
    clear
    print_summary
    print_tasks
    cat <<EOF
Commands:
  1) Start workers
  2) Stop workers
  3) Retry failed tasks
  4) Show status
  5) Show latest summary
  q) Quit
EOF
    printf "\nChoose: "
    read -r choice
    case "$choice" in
      1) "$REPO_ROOT/agentic-development/foundry.sh" headless; read -r -p "Enter to continue..." _ ;;
      2) "$REPO_ROOT/agentic-development/foundry.sh" stop; read -r -p "Enter to continue..." _ ;;
      3) "$REPO_ROOT/agentic-development/foundry.sh" retry; read -r -p "Enter to continue..." _ ;;
      4) "$REPO_ROOT/agentic-development/foundry.sh" status; read -r -p "Enter to continue..." _ ;;
      5)
        latest=$(find "$PIPELINE_TASKS_ROOT" -maxdepth 2 -type f -path '*--foundry/summary.md' -size +0c -print0 2>/dev/null | xargs -0 stat -f '%m %N' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2- || true)
        if [[ -n "$latest" ]]; then
          less "$latest"
        else
          echo "No Foundry summaries yet."
          read -r -p "Enter to continue..." _
        fi
        ;;
      q|Q) exit 0 ;;
    esac
  done
}

run_menu
