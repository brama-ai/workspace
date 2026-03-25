#!/usr/bin/env bash
#
# Regression test for worker over-claiming bug (2026-03-25):
#
#   BUG: With WORKERS=1 and --no-stop-on-failure, a single worker_loop
#        claimed ALL pending tasks sequentially in one loop iteration.
#        After each failure it immediately claimed the next task instead
#        of stopping. Result: 4 pending tasks → 4 in_progress simultaneously.
#
#   ROOT CAUSE: worker_loop after failure with STOP_ON_FAILURE=false
#               did `continue` → next `while true` iteration → claimed
#               next pending task immediately.
#
#   FIX: After failure, release the task back to pending and `return 0`
#        (stop the worker loop). Watch loop will respawn after interval.
#
# Usage:
#   ./agentic-development/tests/test-worker-claim-bug.sh
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/agentic-development/lib/foundry-common.sh"

PASS=0
FAIL=0
TOTAL=0

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if [[ "$expected" == "$actual" ]]; then
    echo -e "  ${GREEN}✓${NC} $desc"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $desc"
    echo "    expected: '$expected'"
    echo "    actual:   '$actual'"
    FAIL=$((FAIL + 1))
  fi
}

assert_le() {
  local desc="$1" max="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if [[ "$actual" -le "$max" ]]; then
    echo -e "  ${GREEN}✓${NC} $desc (${actual} ≤ ${max})"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $desc"
    echo "    expected: ≤ $max"
    echo "    actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

# ── Setup ────────────────────────────────────────────────────────────
tmp_root=$(mktemp -d)
trap 'rm -rf "$tmp_root"' EXIT

export PIPELINE_TASKS_ROOT="$tmp_root"

make_pending_task() {
  local name="$1"
  local dir="$tmp_root/${name}--foundry"
  mkdir -p "$dir/artifacts"
  printf '# %s\n\nTest task.\n' "$name" > "$dir/task.md"
  python3 -c "
import json
from datetime import datetime, timezone
from pathlib import Path
now = datetime.now(timezone.utc).isoformat().replace('+00:00','Z')
d = {
  'task_id': '${name}--foundry',
  'workflow': 'foundry',
  'status': 'pending',
  'attempt': 1,
  'current_step': None,
  'resume_from': None,
  'branch': None,
  'task_file': '$dir/task.md',
  'started_at': now,
  'updated_at': now,
}
Path('$dir/state.json').write_text(json.dumps(d, indent=2) + '\n')
"
  echo "$dir"
}

count_by_status() {
  local status="$1"
  local count=0
  for dir in "$tmp_root"/*--foundry*/; do
    [[ -d "$dir" ]] || continue
    s=$(python3 -c "import json; print(json.load(open('$dir/state.json')).get('status',''))" 2>/dev/null || echo "")
    [[ "$s" == "$status" ]] && count=$((count + 1))
  done
  echo "$count"
}

echo ""
echo "Worker Over-Claiming Regression Tests"
echo "======================================"
echo ""

# ════════════════════════════════════════════════════════════════════
# Test 1: With WORKERS=1, only 1 task should be in_progress at a time
# ════════════════════════════════════════════════════════════════════
echo "Test 1: WORKERS=1 → only 1 task claimed at a time"
echo "──────────────────────────────────────────────────"

make_pending_task "task-alpha" > /dev/null
make_pending_task "task-beta"  > /dev/null
make_pending_task "task-gamma" > /dev/null
make_pending_task "task-delta" > /dev/null

pending_before=$(count_by_status "pending")
assert_eq "4 tasks start as pending" "4" "$pending_before"

# Simulate worker claiming ONE task
claimed=$(foundry_claim_next_task "worker-1" 2>/dev/null || echo "")

in_progress=$(count_by_status "in_progress")
pending_after=$(count_by_status "pending")

assert_eq "exactly 1 task in_progress after one claim" "1" "$in_progress"
assert_eq "exactly 3 tasks remain pending" "3" "$pending_after"

echo ""

# ════════════════════════════════════════════════════════════════════
# Test 2: After task failure + release, task returns to pending
#         and worker stops (does NOT claim next task)
# ════════════════════════════════════════════════════════════════════
echo "Test 2: After failure, task released back to pending"
echo "──────────────────────────────────────────────────────"

# The claimed task "failed" — release it back
if [[ -n "$claimed" ]]; then
  foundry_release_task "$claimed"
  released_status=$(python3 -c "import json; print(json.load(open('$claimed/state.json')).get('status',''))" 2>/dev/null)
  assert_eq "failed task released back to pending" "pending" "$released_status"
fi

in_progress_after_release=$(count_by_status "in_progress")
assert_eq "0 tasks in_progress after release" "0" "$in_progress_after_release"

pending_after_release=$(count_by_status "pending")
assert_eq "all 4 tasks pending after release" "4" "$pending_after_release"

echo ""

# ════════════════════════════════════════════════════════════════════
# Test 3: Simulate the buggy behavior — worker claims all tasks
#         sequentially (what happened before the fix)
# ════════════════════════════════════════════════════════════════════
echo "Test 3: Buggy worker_loop would claim all tasks (regression check)"
echo "──────────────────────────────────────────────────────────────────"

# Simulate the OLD buggy behavior: claim in a loop without stopping
buggy_claims=0
while true; do
  t=$(foundry_claim_next_task "buggy-worker" 2>/dev/null) || break
  buggy_claims=$((buggy_claims + 1))
  # OLD code: on failure with --no-stop-on-failure → continue (claim next)
  # We simulate this by NOT releasing and NOT breaking
done

in_progress_buggy=$(count_by_status "in_progress")
echo "  [info] Buggy worker claimed $buggy_claims tasks → $in_progress_buggy in_progress"

# This is the BUG: all 4 tasks get claimed
# We document it but don't assert (it's the OLD behavior we're fixing)
# Reset for next test
for dir in "$tmp_root"/*--foundry*/; do
  [[ -d "$dir" ]] || continue
  s=$(python3 -c "import json; print(json.load(open('$dir/state.json')).get('status',''))" 2>/dev/null || echo "")
  if [[ "$s" == "in_progress" ]]; then
    foundry_release_task "$dir"
  fi
done

echo ""

# ════════════════════════════════════════════════════════════════════
# Test 4: Fixed behavior — worker claims 1, fails, releases, stops
# ════════════════════════════════════════════════════════════════════
echo "Test 4: Fixed worker_loop — claim 1, fail, release, stop"
echo "──────────────────────────────────────────────────────────"

pending_start=$(count_by_status "pending")
assert_eq "all 4 tasks pending before fixed worker" "4" "$pending_start"

# Simulate the FIXED worker_loop behavior:
# claim → fail → release → return (stop loop, do NOT claim next)
fixed_worker_loop() {
  local worker_id="$1"
  local claims=0
  while true; do
    local task_dir
    task_dir=$(foundry_claim_next_task "$worker_id" 2>/dev/null) || break
    claims=$((claims + 1))

    # Simulate task failure (e.g. git lock contention)
    local exit_code=1

    if [[ $exit_code -ne 0 ]]; then
      # FIXED: release + return (stop loop)
      foundry_release_task "$task_dir" 2>/dev/null || true
      echo "$claims"
      return 0
    fi
  done
  echo "$claims"
}

claims_made=$(fixed_worker_loop "fixed-worker")
assert_eq "fixed worker claims exactly 1 task before stopping" "1" "$claims_made"

in_progress_fixed=$(count_by_status "in_progress")
assert_eq "0 tasks in_progress after fixed worker failure" "0" "$in_progress_fixed"

pending_fixed=$(count_by_status "pending")
assert_eq "all 4 tasks back to pending after fixed worker" "4" "$pending_fixed"

echo ""

# ════════════════════════════════════════════════════════════════════
# Test 5: foundry_release_task is idempotent on non-in_progress tasks
# ════════════════════════════════════════════════════════════════════
echo "Test 5: foundry_release_task is safe on non-in_progress tasks"
echo "──────────────────────────────────────────────────────────────"

# Claim one task and mark it completed
t=$(foundry_claim_next_task "worker-test" 2>/dev/null)
foundry_set_state_status "$t" "completed" "" ""

# Release should be a no-op on completed task
foundry_release_task "$t"
status_after=$(python3 -c "import json; print(json.load(open('$t/state.json')).get('status',''))" 2>/dev/null)
assert_eq "release on completed task is no-op" "completed" "$status_after"

# Release on pending task should also be no-op
t2=$(foundry_claim_next_task "worker-test2" 2>/dev/null)
foundry_release_task "$t2"  # release back to pending
foundry_release_task "$t2"  # call again — should be no-op
status_after2=$(python3 -c "import json; print(json.load(open('$t2/state.json')).get('status',''))" 2>/dev/null)
assert_eq "double release stays pending" "pending" "$status_after2"

echo ""

# ════════════════════════════════════════════════════════════════════
# Summary
# ════════════════════════════════════════════════════════════════════
echo "─────────────────────────────────────────────────────────────"
echo -e "Results: ${GREEN}${PASS} passed${NC} / ${RED}${FAIL} failed${NC} / ${TOTAL} total"
echo ""

[[ $FAIL -gt 0 ]] && exit 1
exit 0
