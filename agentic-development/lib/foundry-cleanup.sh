#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="${PIPELINE_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
# shellcheck source=/dev/null
source "$REPO_ROOT/agentic-development/lib/foundry-common.sh"

maybe_migrate_legacy_foundry_tasks
ensure_foundry_task_root

APPLY=false
MAX_DAYS="${CLEANUP_MAX_DAYS:-7}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=true; shift ;;
    --days) MAX_DAYS="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: ./agentic-development/foundry.sh cleanup [--apply] [--days N]"
      exit 0
      ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

remove_path() {
  local path="$1"
  if [[ "$APPLY" == true ]]; then
    rm -rf "$path"
    echo "deleted ${path#$REPO_ROOT/}"
  else
    echo "[dry-run] delete ${path#$REPO_ROOT/}"
  fi
}

while IFS= read -r task_dir; do
  [[ -n "$task_dir" ]] || continue
  status=$(foundry_state_field "$task_dir" status 2>/dev/null || echo "pending")
  if [[ "$status" == "completed" || "$status" == "failed" || "$status" == "cancelled" ]]; then
    mtime=$(stat -f %m "$task_dir" 2>/dev/null || stat -c %Y "$task_dir" 2>/dev/null || echo 0)
    now=$(date +%s)
    age_days=$(( (now - mtime) / 86400 ))
    if (( age_days > MAX_DAYS )); then
      # 10.2: Archive guard — skip tasks with empty or missing summary.md
      summary_file="$task_dir/summary.md"
      if [[ ! -s "$summary_file" ]]; then
        echo "[skip] $(basename "$task_dir") — summary.md is empty or missing (not archiving)"
        pipeline_task_append_event "$task_dir" "archive_blocked" "Cleanup skipped: summary.md is empty or missing" 2>/dev/null || true
        continue
      fi
      remove_path "$task_dir"
    fi
  fi
done < <(foundry_list_task_dirs)

for pycache in "$REPO_ROOT/agentic-development/__pycache__" "$REPO_ROOT/agentic-development/lib/__pycache__"; do
  [[ -d "$pycache" ]] && remove_path "$pycache"
done

if [[ -f "$REPO_ROOT/agentic-development/.DS_Store" ]]; then
  remove_path "$REPO_ROOT/agentic-development/.DS_Store"
fi
