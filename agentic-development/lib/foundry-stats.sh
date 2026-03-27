#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="${PIPELINE_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
# shellcheck source=/dev/null
source "$REPO_ROOT/agentic-development/lib/foundry-common.sh"

ensure_foundry_task_root

LIST_MODE=false
TARGET=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --list) LIST_MODE=true; shift ;;
    --help|-h)
      echo "Usage: ./agentic-development/foundry.sh stats [--list] [slug]"
      exit 0
      ;;
    *) TARGET="$1"; shift ;;
  esac
done

show_task() {
  local task_dir="$1"
  local state status attempt branch
  status=$(foundry_state_field "$task_dir" status 2>/dev/null || echo "pending")
  attempt=$(foundry_state_field "$task_dir" attempt 2>/dev/null || echo "1")
  branch=$(foundry_state_field "$task_dir" branch 2>/dev/null || echo "-")
  echo "Task: $(basename "$task_dir")"
  echo "Status: $status"
  echo "Attempt: $attempt"
  echo "Branch: $branch"
  echo "Summary: $(foundry_summary_file "$task_dir")"
  echo "Handoff: $(foundry_handoff_file "$task_dir")"
  echo "Checkpoint: $(foundry_checkpoint_file "$task_dir")"
}

if [[ "$LIST_MODE" == true ]]; then
  while IFS= read -r task_dir; do
    [[ -n "$task_dir" ]] || continue
    status=$(foundry_state_field "$task_dir" status 2>/dev/null || echo "pending")
    attempt=$(foundry_state_field "$task_dir" attempt 2>/dev/null || echo "1")
    printf "%-48s %-12s attempt=%s\n" "$(basename "$task_dir")" "$status" "$attempt"
  done < <(foundry_list_task_dirs)
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
  done < <(foundry_list_task_dirs)
  [[ -n "$match" ]] || { echo "No Foundry task matching '$TARGET'." >&2; exit 1; }
  show_task "$match"
  exit 0
fi

latest=$(find "$PIPELINE_TASKS_ROOT" -maxdepth 1 -type d -name '*--foundry*' -print0 2>/dev/null | xargs -0 stat -f '%m %N' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2- || true)
if [[ -z "$latest" ]]; then
  echo "No Foundry task directories found."
  exit 1
fi
show_task "$latest"
