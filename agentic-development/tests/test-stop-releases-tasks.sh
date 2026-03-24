#!/usr/bin/env bash
#
# Test: stopping batch workers moves in_progress tasks to "cancelled"
#
# Verifies that cleanup_all() in foundry-batch.sh transitions
# in_progress tasks to cancelled state when workers are killed.
#
# Usage:
#   ./agentic-development/tests/test-stop-releases-tasks.sh
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
    echo "    expected: $expected"
    echo "    actual:   $actual"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "Stop releases in_progress tasks"
echo "================================"
echo ""

tmp_root=$(mktemp -d)
trap 'rm -rf "$tmp_root"' EXIT

# ── Test 1: foundry_stop_headless cancels in_progress tasks ─────────

echo "Test 1: cleanup moves in_progress → cancelled"

task1="$tmp_root/task-one--foundry"
task2="$tmp_root/task-two--foundry"
task3="$tmp_root/task-three--foundry"
mkdir -p "$task1" "$task2" "$task3"
printf '# Task one\n' > "$task1/task.md"
printf '# Task two\n' > "$task2/task.md"
printf '# Task three\n' > "$task3/task.md"

# task1: in_progress (should be cancelled)
foundry_set_state_status "$task1" "in_progress" "u-coder" "u-coder"
# task2: in_progress (should be cancelled)
foundry_set_state_status "$task2" "in_progress" "u-validator" "u-validator"
# task3: pending (should stay pending)
foundry_set_state_status "$task3" "pending" "" ""

# Simulate what foundry_stop_headless should do
PIPELINE_TASKS_ROOT="$tmp_root" foundry_cancel_in_progress_tasks

s1=$(foundry_state_field "$task1" status)
s2=$(foundry_state_field "$task2" status)
s3=$(foundry_state_field "$task3" status)

assert_eq "in_progress task1 → cancelled" "cancelled" "$s1"
assert_eq "in_progress task2 → cancelled" "cancelled" "$s2"
assert_eq "pending task3 stays pending"    "pending"   "$s3"

echo ""

# ── Test 2: cancelled task gets stop event in events.jsonl ──────────

echo "Test 2: cancelled tasks get stop event logged"

events_file="$task1/events.jsonl"
if [[ -f "$events_file" ]]; then
  last_event_type=$(tail -1 "$events_file" | python3 -c "import sys,json; print(json.load(sys.stdin)['type'])")
  assert_eq "last event is 'stopped'" "stopped" "$last_event_type"
else
  assert_eq "events.jsonl exists" "true" "false"
fi

echo ""

# ── Test 3: completed/failed tasks not affected ─────────────────────

echo "Test 3: completed/failed tasks not affected by cancel"

task4="$tmp_root/task-done--foundry"
task5="$tmp_root/task-failed--foundry"
mkdir -p "$task4" "$task5"
printf '# Task done\n' > "$task4/task.md"
printf '# Task failed\n' > "$task5/task.md"

foundry_set_state_status "$task4" "completed" "" ""
foundry_set_state_status "$task5" "failed" "u-tester" "u-tester"

PIPELINE_TASKS_ROOT="$tmp_root" foundry_cancel_in_progress_tasks

s4=$(foundry_state_field "$task4" status)
s5=$(foundry_state_field "$task5" status)

assert_eq "completed stays completed" "completed" "$s4"
assert_eq "failed stays failed"       "failed"    "$s5"

echo ""
echo "================================"
echo -e "Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}, ${TOTAL} total"
echo ""

[[ $FAIL -eq 0 ]] && exit 0 || exit 1
