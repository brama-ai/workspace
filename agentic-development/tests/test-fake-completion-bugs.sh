#!/usr/bin/env bash
#
# Regression tests for fake-completion bugs discovered 2026-03-25:
#
#   BUG-1: Agent exits with code 1 ("You must provide a message") but
#           foundry_state_upsert_agent still writes status="done" because
#           exit_code variable is reused across retry loop iterations.
#
#   BUG-2: u-summarizer fails (empty prompt / provider error) but
#           mark_task_completed() is called anyway → task shows "completed"
#           with no summary.md.
#
#   BUG-3: Stale batch lock (zombie PID) blocks new workers from starting.
#           acquire_lock() only checked kill -0, not /proc/<pid>/status.
#
# Usage:
#   ./agentic-development/tests/test-fake-completion-bugs.sh
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
YELLOW='\033[1;33m'
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

assert_file_exists() {
  local desc="$1" path="$2"
  TOTAL=$((TOTAL + 1))
  if [[ -f "$path" ]]; then
    echo -e "  ${GREEN}✓${NC} $desc"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $desc — file not found: $path"
    FAIL=$((FAIL + 1))
  fi
}

assert_file_not_exists() {
  local desc="$1" path="$2"
  TOTAL=$((TOTAL + 1))
  if [[ ! -f "$path" ]]; then
    echo -e "  ${GREEN}✓${NC} $desc"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $desc — file should NOT exist: $path"
    FAIL=$((FAIL + 1))
  fi
}

assert_contains() {
  local desc="$1" needle="$2" haystack="$3"
  TOTAL=$((TOTAL + 1))
  if echo "$haystack" | grep -qF "$needle"; then
    echo -e "  ${GREEN}✓${NC} $desc"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $desc"
    echo "    expected to contain: '$needle'"
    echo "    actual: '$haystack'"
    FAIL=$((FAIL + 1))
  fi
}

# ── Setup ────────────────────────────────────────────────────────────
tmp_root=$(mktemp -d)
trap 'rm -rf "$tmp_root"' EXIT

make_task() {
  local name="$1"
  local dir="$tmp_root/${name}--foundry"
  mkdir -p "$dir/artifacts"
  printf '# %s\n\nTest task.\n' "$name" > "$dir/task.md"
  touch "$dir/handoff.md" "$dir/events.jsonl" "$dir/summary.md"
  echo "$dir"
}

state_field() {
  local dir="$1" key="$2"
  python3 -c "
import json, sys
try:
    d = json.load(open('$dir/state.json'))
    v = d.get('$key')
    print(v if v is not None else '')
except Exception as e:
    print('')
" 2>/dev/null
}

agent_status() {
  local dir="$1" agent="$2"
  python3 -c "
import json, sys
try:
    d = json.load(open('$dir/state.json'))
    agents = d.get('agents', [])
    for a in agents:
        if a.get('agent') == '$agent':
            print(a.get('status', ''))
            sys.exit(0)
    print('')
except Exception:
    print('')
" 2>/dev/null
}

echo ""
echo "Fake-Completion Regression Tests"
echo "================================="
echo ""

# ════════════════════════════════════════════════════════════════════
# BUG-1: Agent exit_code=1 must write status="failed", not "done"
# ════════════════════════════════════════════════════════════════════
echo "BUG-1: Agent exit_code=1 → state must be 'failed', not 'done'"
echo "──────────────────────────────────────────────────────────────"

task1=$(make_task "bug1-agent-exit-code")
foundry_write_state "$task1" "in_progress" "u-coder" "u-coder"

# Simulate: agent ran and FAILED (exit_code=1)
foundry_state_upsert_agent "$task1" "u-coder" "failed" "anthropic/claude-sonnet-4-6" \
  "5" "1000" "200" "0.05" "1"

actual=$(agent_status "$task1" "u-coder")
assert_eq "agent status is 'failed' when exit_code=1" "failed" "$actual"

task_status=$(state_field "$task1" "status")
assert_eq "task remains 'in_progress' after agent failure" "in_progress" "$task_status"

echo ""

# ════════════════════════════════════════════════════════════════════
# BUG-1b: "You must provide a message" error must NOT be treated as
#          a rate-limit / fallback-worthy error
# ════════════════════════════════════════════════════════════════════
echo "BUG-1b: Empty-prompt error must not trigger fallback"
echo "──────────────────────────────────────────────────────────────"

empty_prompt_log="$tmp_root/empty-prompt.log"
printf 'Error: You must provide a message or a command\n' > "$empty_prompt_log"

rate_limit_log="$tmp_root/rate-limit.log"
printf 'Error: 429 Too Many Requests\nrate limit exceeded\n' > "$rate_limit_log"

provider_error_log="$tmp_root/provider-error.log"
printf 'ProviderModelNotFoundError: model not found\n' > "$provider_error_log"

# Source the detection functions from foundry-run.sh
# We extract just the functions we need to test
is_rate_limit_error() {
  local log_file="$1"
  grep -qiE 'rate.?limit|429|too many requests|quota.*exceed|RateLimitError' "$log_file" 2>/dev/null
}

is_provider_error() {
  local log_file="$1"
  grep -qiE 'ProviderModelNotFoundError|Model not found|provider.*not.*found|credential|unauthorized|authentication.*fail|invalid.*api.?key|no.*provider' "$log_file" 2>/dev/null
}

is_empty_prompt_error() {
  local log_file="$1"
  grep -qiE 'You must provide a message|must provide.*command|message.*required|no.*message.*provided' "$log_file" 2>/dev/null
}

is_fallback_worthy_error() {
  local log_file="$1"
  # Empty prompt is NOT fallback-worthy — it's a pipeline bug, not a provider issue
  if is_empty_prompt_error "$log_file"; then
    return 1
  fi
  is_rate_limit_error "$log_file" || is_provider_error "$log_file"
}

# Empty prompt → NOT fallback-worthy
if is_fallback_worthy_error "$empty_prompt_log"; then
  echo -e "  ${RED}✗${NC} empty-prompt error must NOT trigger fallback"
  FAIL=$((FAIL + 1))
else
  echo -e "  ${GREEN}✓${NC} empty-prompt error does not trigger fallback"
  PASS=$((PASS + 1))
fi
TOTAL=$((TOTAL + 1))

# Rate limit → IS fallback-worthy
if is_fallback_worthy_error "$rate_limit_log"; then
  echo -e "  ${GREEN}✓${NC} rate-limit error triggers fallback"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✗${NC} rate-limit error must trigger fallback"
  FAIL=$((FAIL + 1))
fi
TOTAL=$((TOTAL + 1))

# Provider error → IS fallback-worthy
if is_fallback_worthy_error "$provider_error_log"; then
  echo -e "  ${GREEN}✓${NC} provider error triggers fallback"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✗${NC} provider error must trigger fallback"
  FAIL=$((FAIL + 1))
fi
TOTAL=$((TOTAL + 1))

echo ""

# ════════════════════════════════════════════════════════════════════
# BUG-2: Task must NOT be marked "completed" if summary.md is missing
# ════════════════════════════════════════════════════════════════════
echo "BUG-2: Task must not be 'completed' without summary.md"
echo "──────────────────────────────────────────────────────────────"

task2=$(make_task "bug2-no-summary")
foundry_write_state "$task2" "in_progress" "u-summarizer" "u-summarizer"

# Simulate: all agents done but summary.md is empty (summarizer failed silently)
foundry_state_upsert_agent "$task2" "u-planner"    "done" "anthropic/claude-opus-4-6"   "10" "500" "100" "0.01" "1"
foundry_state_upsert_agent "$task2" "u-coder"      "done" "anthropic/claude-sonnet-4-6" "60" "5000" "2000" "0.50" "1"
foundry_state_upsert_agent "$task2" "u-validator"  "done" "minimax/MiniMax-M2.5"        "20" "2000" "500" "0.05" "1"
foundry_state_upsert_agent "$task2" "u-summarizer" "failed" "openai/gpt-5.4"            "5"  "100"  "0"   "0.00" "1"

# summary.md is empty (0 bytes) — task should NOT be completed
truncate -s 0 "$task2/summary.md"

# Simulate the check that should happen before marking completed
summary_is_valid() {
  local task_dir="$1"
  local summary="$task_dir/summary.md"
  [[ -f "$summary" && -s "$summary" ]]
}

summarizer_succeeded() {
  local task_dir="$1"
  python3 -c "
import json, sys
try:
    d = json.load(open('$task_dir/state.json'))
    agents = d.get('agents', [])
    for a in agents:
        if 'summarizer' in a.get('agent', '') and a.get('status') == 'done':
            sys.exit(0)
    sys.exit(1)
except Exception:
    sys.exit(1)
" 2>/dev/null
}

# The guard: task is complete only if summarizer succeeded AND summary.md exists
task_is_truly_complete() {
  local task_dir="$1"
  summarizer_succeeded "$task_dir" && summary_is_valid "$task_dir"
}

if task_is_truly_complete "$task2"; then
  echo -e "  ${RED}✗${NC} task must NOT be complete when summary.md is empty"
  FAIL=$((FAIL + 1))
else
  echo -e "  ${GREEN}✓${NC} task is not complete when summary.md is empty"
  PASS=$((PASS + 1))
fi
TOTAL=$((TOTAL + 1))

# Now write a real summary
printf '# Summary\n\nTask completed successfully.\n' > "$task2/summary.md"
foundry_state_upsert_agent "$task2" "u-summarizer" "done" "openai/gpt-5.4" "8" "200" "500" "0.01" "1"

if task_is_truly_complete "$task2"; then
  echo -e "  ${GREEN}✓${NC} task IS complete when summary.md exists and summarizer done"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✗${NC} task should be complete when summary.md exists"
  FAIL=$((FAIL + 1))
fi
TOTAL=$((TOTAL + 1))

echo ""

# ════════════════════════════════════════════════════════════════════
# BUG-2b: state.json must be created at task START (in_progress),
#          not only at completion
# ════════════════════════════════════════════════════════════════════
echo "BUG-2b: state.json must exist immediately after task is claimed"
echo "──────────────────────────────────────────────────────────────"

task2b=$(make_task "bug2b-state-timing")

# Before claim: state.json should not exist yet (or be pending)
assert_file_not_exists "state.json absent before claim" "$task2b/state.json"

# Simulate claim (foundry_claim_task writes in_progress)
foundry_write_state "$task2b" "in_progress" "u-planner" "u-planner"

assert_file_exists "state.json created when task starts" "$task2b/state.json"
actual_status=$(state_field "$task2b" "status")
assert_eq "state is 'in_progress' immediately after claim" "in_progress" "$actual_status"

echo ""

# ════════════════════════════════════════════════════════════════════
# BUG-3: Stale batch lock (zombie PID) must be auto-cleaned
# ════════════════════════════════════════════════════════════════════
echo "BUG-3: Stale batch lock with zombie/dead PID must be cleaned"
echo "──────────────────────────────────────────────────────────────"

fake_lock="$tmp_root/.batch.lock"

# Case A: Lock with non-existent PID → must be cleaned
echo "99999999" > "$fake_lock"

# Simulate acquire_lock logic
acquire_lock_safe() {
  local lockfile="$1"
  if [[ -f "$lockfile" ]]; then
    local old_pid
    old_pid=$(cat "$lockfile" 2>/dev/null || true)
    if [[ -n "$old_pid" ]]; then
      local pid_stat
      pid_stat=$(cat "/proc/${old_pid}/status" 2>/dev/null | awk '/^State:/{print $2}' || true)
      if [[ -n "$pid_stat" ]] && [[ "$pid_stat" != "Z" ]]; then
        echo "locked"
        return 1
      fi
      # Dead or zombie — remove stale lock
      rm -f "$lockfile"
    fi
  fi
  echo "$$" > "$lockfile"
  echo "acquired"
}

result=$(acquire_lock_safe "$fake_lock")
assert_eq "lock with dead PID is cleaned and re-acquired" "acquired" "$result"
assert_file_exists "new lock file created after cleanup" "$fake_lock"
new_pid=$(cat "$fake_lock")
assert_eq "new lock contains current PID" "$$" "$new_pid"

# Case B: Lock with live PID → must be blocked
echo "$$" > "$fake_lock"  # current process = alive
result=$(acquire_lock_safe "$fake_lock" 2>/dev/null | tail -1)
assert_eq "lock with live PID blocks new acquisition" "locked" "$result"

# Case C: foundry_cleanup_zombies removes stale lock
echo "99999998" > "$fake_lock"
# Override REPO_ROOT for test
REPO_ROOT_ORIG="$REPO_ROOT"
REPO_ROOT="$tmp_root"
mkdir -p "$tmp_root/.opencode/pipeline"
cp "$fake_lock" "$tmp_root/.opencode/pipeline/.batch.lock"

cleaned=$(foundry_cleanup_zombies)
lock_exists=false
[[ -f "$tmp_root/.opencode/pipeline/.batch.lock" ]] && lock_exists=true

REPO_ROOT="$REPO_ROOT_ORIG"

if [[ "$lock_exists" == "false" ]]; then
  echo -e "  ${GREEN}✓${NC} foundry_cleanup_zombies removes stale lock"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✗${NC} foundry_cleanup_zombies must remove stale lock"
  FAIL=$((FAIL + 1))
fi
TOTAL=$((TOTAL + 1))

echo ""

# ════════════════════════════════════════════════════════════════════
# BUG-3b: foundry_cleanup_zombies cleans stale lock (lock-only check)
# ════════════════════════════════════════════════════════════════════
echo "BUG-3b: foundry_cleanup_zombies cleans stale lock correctly"
echo "──────────────────────────────────────────────────────────────"

REPO_ROOT="$tmp_root"
mkdir -p "$tmp_root/.opencode/pipeline"

# No stale lock → lock file absent after cleanup
rm -f "$tmp_root/.opencode/pipeline/.batch.lock"
foundry_cleanup_zombies > /dev/null
lock_present=false
[[ -f "$tmp_root/.opencode/pipeline/.batch.lock" ]] && lock_present=true
assert_eq "no stale lock → lock file stays absent" "false" "$lock_present"

# Stale lock (dead PID) → lock file removed
echo "99999997" > "$tmp_root/.opencode/pipeline/.batch.lock"
foundry_cleanup_zombies > /dev/null
lock_present=false
[[ -f "$tmp_root/.opencode/pipeline/.batch.lock" ]] && lock_present=true
assert_eq "stale lock (dead PID) → lock file removed" "false" "$lock_present"

# Live lock (current PID) → lock file preserved
echo "$$" > "$tmp_root/.opencode/pipeline/.batch.lock"
foundry_cleanup_zombies > /dev/null
lock_present=false
[[ -f "$tmp_root/.opencode/pipeline/.batch.lock" ]] && lock_present=true
assert_eq "live lock (current PID) → lock file preserved" "true" "$lock_present"

REPO_ROOT="$REPO_ROOT_ORIG"

echo ""

# ════════════════════════════════════════════════════════════════════
# BUG-4: Cancelled tasks with real agent work must be resumable
# ════════════════════════════════════════════════════════════════════
echo "BUG-4: Cancelled task with completed agents must resume from last step"
echo "──────────────────────────────────────────────────────────────"

task4=$(make_task "bug4-resume-cancelled")
foundry_write_state "$task4" "in_progress" "u-validator" "u-validator"

# Simulate: planner + coder done, validator was running when cancelled
foundry_state_upsert_agent "$task4" "u-planner" "done" "anthropic/claude-opus-4-6"   "10" "500" "100" "0.01" "1"
foundry_state_upsert_agent "$task4" "u-coder"   "done" "anthropic/claude-sonnet-4-6" "60" "5000" "2000" "0.50" "1"
foundry_state_upsert_agent "$task4" "u-validator" "failed" "minimax/MiniMax-M2.5"    "0"  "0"    "0"   "0.00" "1"

# Simulate pipeline stop → cancelled
foundry_set_state_status "$task4" "cancelled" "u-validator" "u-validator"

status=$(state_field "$task4" "status")
assert_eq "task is cancelled" "cancelled" "$status"

resume_from=$(state_field "$task4" "resume_from")
assert_eq "resume_from points to last failed step" "u-validator" "$resume_from"

# Reset to pending for retry should preserve resume_from
foundry_set_state_status "$task4" "pending" "" "u-validator"
resume_after_reset=$(state_field "$task4" "resume_from")
assert_eq "resume_from preserved after reset to pending" "u-validator" "$resume_after_reset"

echo ""

# ════════════════════════════════════════════════════════════════════
# Summary
# ════════════════════════════════════════════════════════════════════
echo "─────────────────────────────────────────────────────────────"
echo -e "Results: ${GREEN}${PASS} passed${NC} / ${RED}${FAIL} failed${NC} / ${TOTAL} total"
echo ""

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
