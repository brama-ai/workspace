#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="${PIPELINE_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
# shellcheck source=/dev/null
source "$REPO_ROOT/agentic-development/lib/foundry-common.sh"

maybe_migrate_legacy_foundry_tasks
ensure_foundry_task_root

MODE="retry"
TARGET=""

show_help() {
  cat <<EOF
Foundry retry

Usage:
  ./agentic-development/foundry.sh retry
  ./agentic-development/foundry.sh retry --list
  ./agentic-development/foundry.sh retry <slug>
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --list|-l) MODE="list"; shift ;;
    --help|-h) show_help; exit 0 ;;
    *) TARGET="$1"; shift ;;
  esac
done

list_failed() {
  local task_dir
  while IFS= read -r task_dir; do
    [[ -n "$task_dir" ]] || continue
    local attempt
    attempt=$(foundry_state_field "$task_dir" attempt 2>/dev/null || echo "1")
    echo "$(basename "$task_dir") (attempt ${attempt})"
  done < <(foundry_find_tasks_by_status "failed")
}

retry_task() {
  local task_dir="$1"
  foundry_increment_attempt "$task_dir"
  foundry_set_state_status "$task_dir" "pending" "" ""
  pipeline_task_append_event "$task_dir" "retry_requested" "Task returned to pending"
  echo "Retried $(basename "$task_dir")"
}

if [[ "$MODE" == "list" ]]; then
  list_failed
  exit 0
fi

if [[ -n "$TARGET" ]]; then
  match=""
  while IFS= read -r task_dir; do
    [[ -n "$task_dir" ]] || continue
    if [[ "$(basename "$task_dir")" == *"$TARGET"* ]]; then
      match="$task_dir"
      break
    fi
  done < <(foundry_find_tasks_by_status "failed")
  [[ -n "$match" ]] || { echo "No failed Foundry task matching '$TARGET'." >&2; exit 1; }
  retry_task "$match"
  exit 0
fi

count=0
while IFS= read -r task_dir; do
  [[ -n "$task_dir" ]] || continue
  retry_task "$task_dir"
  count=$((count + 1))
done < <(foundry_find_tasks_by_status "failed")

[[ "$count" -gt 0 ]] || echo "No failed Foundry tasks."
