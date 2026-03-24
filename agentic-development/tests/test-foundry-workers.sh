#!/usr/bin/env bash
#
# Tests for Foundry multi-worker functionality:
# - Atomic task claiming (foundry_claim_task, foundry_claim_next_task)
# - Task release
# - Worktree path helpers
# - Batch script syntax
# - Worker state in state.json
# - Concurrent claim safety
#
# Usage:
#   ./agentic-development/tests/test-foundry-workers.sh
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
COMMON="$REPO_ROOT/agentic-development/lib/foundry-common.sh"
BATCH="$REPO_ROOT/agentic-development/lib/foundry-batch.sh"

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

assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  TOTAL=$((TOTAL + 1))
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo -e "  ${GREEN}✓${NC} $desc"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $desc"
    echo "    expected to contain: $needle"
    echo "    actual: ${haystack:0:200}"
    FAIL=$((FAIL + 1))
  fi
}

file_contains() {
  local desc="$1" needle="$2" file="$3"
  TOTAL=$((TOTAL + 1))
  if grep -qF -- "$needle" "$file"; then
    echo -e "  ${GREEN}✓${NC} $desc"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $desc"
    echo "    expected file to contain: $needle"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "Foundry Multi-Worker Tests"
echo "=========================="
echo ""

# ── Test 1: Script syntax ────────────────────────────────────────────
echo "Test 1: syntax valid"

syntax_common=$(bash -n "$COMMON" 2>&1)
assert_eq "foundry-common.sh valid syntax" "" "$syntax_common"

syntax_batch=$(bash -n "$BATCH" 2>&1)
assert_eq "foundry-batch.sh valid syntax" "" "$syntax_batch"

# ── Test 2: foundry_claim_task basic ─────────────────────────────────
echo ""
echo "Test 2: foundry_claim_task"

tmp_root=$(mktemp -d)
trap 'rm -rf "$tmp_root"' EXIT

# Source common in bash (not zsh) to avoid readonly issues
claim_result=$(bash -c '
source "'"$COMMON"'"
PIPELINE_TASKS_ROOT="'"$tmp_root"'"
FOUNDRY_TASK_ROOT="'"$tmp_root"'"

task_dir="'"$tmp_root"'/claim-test--foundry"
mkdir -p "$task_dir"
cat > "$task_dir/state.json" <<EOF
{"task_id": "claim-test", "status": "pending", "workflow": "foundry"}
EOF

if foundry_claim_task "$task_dir" "worker-1"; then
  echo "CLAIMED"
else
  echo "FAILED"
fi

# Read back status
python3 -c "
import json
data = json.load(open(\"$task_dir/state.json\"))
print(data[\"status\"])
print(data.get(\"worker_id\", \"\"))
"
' 2>&1)

claimed_line=$(echo "$claim_result" | head -1)
status_line=$(echo "$claim_result" | sed -n '2p')
worker_line=$(echo "$claim_result" | sed -n '3p')

assert_eq "claim returns CLAIMED" "CLAIMED" "$claimed_line"
assert_eq "status is in_progress after claim" "in_progress" "$status_line"
assert_eq "worker_id is worker-1" "worker-1" "$worker_line"

# ── Test 3: Double claim fails ───────────────────────────────────────
echo ""
echo "Test 3: double claim protection"

double_result=$(bash -c '
source "'"$COMMON"'"
PIPELINE_TASKS_ROOT="'"$tmp_root"'"
FOUNDRY_TASK_ROOT="'"$tmp_root"'"

task_dir="'"$tmp_root"'/claim-test--foundry"
# Task is already in_progress from Test 2

if foundry_claim_task "$task_dir" "worker-2"; then
  echo "CLAIMED"
else
  echo "REJECTED"
fi
' 2>&1)

assert_eq "second claim rejected" "REJECTED" "$double_result"

# ── Test 4: foundry_release_task ─────────────────────────────────────
echo ""
echo "Test 4: foundry_release_task"

release_result=$(bash -c '
source "'"$COMMON"'"
PIPELINE_TASKS_ROOT="'"$tmp_root"'"
FOUNDRY_TASK_ROOT="'"$tmp_root"'"

task_dir="'"$tmp_root"'/claim-test--foundry"
foundry_release_task "$task_dir"

python3 -c "
import json
data = json.load(open(\"$task_dir/state.json\"))
print(data[\"status\"])
"
' 2>&1)

assert_eq "released task is pending" "pending" "$release_result"

# ── Test 5: foundry_claim_next_task with priority ─────────────────────
echo ""
echo "Test 5: foundry_claim_next_task (priority order)"

# Use a separate directory for this test to avoid interference
prio_root=$(mktemp -d)

# Create 3 tasks with different priorities
for prio_name in "low:1" "high:5" "mid:3"; do
  IFS=: read -r name prio <<< "$prio_name"
  task_dir="$prio_root/task-${name}--foundry"
  mkdir -p "$task_dir"
  cat > "$task_dir/state.json" <<EOF
{"task_id": "task-${name}", "status": "pending", "workflow": "foundry"}
EOF
  echo "<!-- priority: ${prio} -->" > "$task_dir/task.md"
  echo "# Task ${name}" >> "$task_dir/task.md"
done

claim_order=$(bash -c '
source "'"$COMMON"'"
PIPELINE_TASKS_ROOT="'"$prio_root"'"
FOUNDRY_TASK_ROOT="'"$prio_root"'"

# Claim 3 tasks in sequence
for i in 1 2 3; do
  result=$(foundry_claim_next_task "worker-test" 2>/dev/null) || break
  basename "$result" | sed "s/--foundry//"
done
' 2>&1)

first_claimed=$(echo "$claim_order" | head -1)
assert_eq "highest priority claimed first" "task-high" "$first_claimed"

second_claimed=$(echo "$claim_order" | sed -n '2p')
assert_eq "medium priority claimed second" "task-mid" "$second_claimed"

third_claimed=$(echo "$claim_order" | sed -n '3p')
assert_eq "lowest priority claimed third" "task-low" "$third_claimed"

rm -rf "$prio_root"

# ── Test 6: No tasks left returns failure ─────────────────────────────
echo ""
echo "Test 6: claim_next returns 1 when no pending tasks"

empty_root=$(mktemp -d)
mkdir -p "$empty_root/done-task--foundry"
cat > "$empty_root/done-task--foundry/state.json" <<'EOF'
{"task_id": "done-task", "status": "completed", "workflow": "foundry"}
EOF

no_task_result=$(bash -c '
source "'"$COMMON"'"
PIPELINE_TASKS_ROOT="'"$empty_root"'"
FOUNDRY_TASK_ROOT="'"$empty_root"'"

if foundry_claim_next_task "worker-x" 2>/dev/null; then
  echo "FOUND"
else
  echo "NONE"
fi
' 2>&1)

rm -rf "$empty_root"

assert_eq "no pending tasks returns NONE" "NONE" "$no_task_result"

# ── Test 7: Worktree path helper ─────────────────────────────────────
echo ""
echo "Test 7: worktree path helpers"

wt_path=$(bash -c '
source "'"$COMMON"'"
foundry_worktree_path "worker-3"
' 2>&1)

assert_contains "worktree path includes worker-3" "worker-3" "$wt_path"
assert_contains "worktree under .pipeline-worktrees" ".pipeline-worktrees" "$wt_path"

# ── Test 8: Concurrent claims (race condition test) ───────────────────
echo ""
echo "Test 8: concurrent claim safety"

# Create a fresh pending task
race_task="$tmp_root/race-test--foundry"
mkdir -p "$race_task"
cat > "$race_task/state.json" <<'EOF'
{"task_id": "race-test", "status": "pending", "workflow": "foundry"}
EOF
echo "# Race test" > "$race_task/task.md"

# Launch 5 workers trying to claim the same task concurrently
race_results=$(bash -c '
source "'"$COMMON"'"
PIPELINE_TASKS_ROOT="'"$tmp_root"'"

for i in 1 2 3 4 5; do
  (
    if foundry_claim_task "'"$race_task"'" "racer-$i" 2>/dev/null; then
      echo "racer-$i:CLAIMED"
    else
      echo "racer-$i:REJECTED"
    fi
  ) &
done
wait
' 2>&1)

claimed_count=$(echo "$race_results" | grep -c "CLAIMED" || true)
rejected_count=$(echo "$race_results" | grep -c "REJECTED" || true)

assert_eq "exactly 1 racer claimed" "1" "$claimed_count"
assert_eq "4 racers rejected" "4" "$rejected_count"

# ── Test 9: state.json has worker_id and claimed_at ───────────────────
echo ""
echo "Test 9: claimed state.json fields"

race_state=$(cat "$race_task/state.json")
assert_contains "state has worker_id" '"worker_id"' "$race_state"
assert_contains "state has claimed_at" '"claimed_at"' "$race_state"
assert_contains "state status is in_progress" '"in_progress"' "$race_state"

# ── Test 10: batch script has parallel worker support ─────────────────
echo ""
echo "Test 10: batch script structure"

file_contains "batch has worker_loop function" "worker_loop()" "$BATCH"
file_contains "batch has spawn_workers function" "spawn_workers()" "$BATCH"
file_contains "batch has cleanup_all function" "cleanup_all()" "$BATCH"
file_contains "batch uses foundry_claim_next_task" "foundry_claim_next_task" "$BATCH"
file_contains "batch uses foundry_create_worktree" "foundry_create_worktree" "$BATCH"
file_contains "batch supports --workers flag" '--workers' "$BATCH"

# ── Test 11: foundry_count_active_workers exists ──────────────────────
echo ""
echo "Test 11: worker counting"

file_contains "common has foundry_count_active_workers" "foundry_count_active_workers()" "$COMMON"
file_contains "common has foundry_list_active_workers" "foundry_list_active_workers()" "$COMMON"

# ── Summary ──────────────────────────────────────────────────────────
echo ""
echo "================================="
echo -e "Results: ${PASS}/${TOTAL} passed, ${FAIL} failed"
if [[ $FAIL -gt 0 ]]; then
  echo -e "${RED}FAIL${NC}"
  exit 1
else
  echo -e "${GREEN}ALL PASSED${NC}"
  exit 0
fi
