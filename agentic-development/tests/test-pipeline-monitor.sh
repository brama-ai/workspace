#!/usr/bin/env bash
#
# Tests for agentic-development/lib/pipeline-monitor.sh
# Tests: tab rendering, agents table parsing, format helpers,
#        state.json agents upsert, key handling state transitions.
#
# Usage:
#   ./agentic-development/tests/test-pipeline-monitor.sh
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
MONITOR="$REPO_ROOT/agentic-development/lib/pipeline-monitor.sh"
COMMON="$REPO_ROOT/agentic-development/lib/foundry-common.sh"

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
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    echo -e "  ${GREEN}✓${NC} $desc"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $desc"
    echo "    expected to contain: $needle"
    echo "    actual: ${haystack:0:200}"
    FAIL=$((FAIL + 1))
  fi
}

# Search for a fixed string in a file (avoids large variable issues)
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

file_not_contains() {
  local desc="$1" needle="$2" file="$3"
  TOTAL=$((TOTAL + 1))
  if ! grep -qF -- "$needle" "$file"; then
    echo -e "  ${GREEN}✓${NC} $desc"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $desc"
    echo "    expected file NOT to contain: $needle"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "pipeline-monitor Tests"
echo "======================"
echo ""

# ── Test 1: Script exists and has valid syntax ──────────────────────
echo "Test 1: script exists and syntax valid"

TOTAL=$((TOTAL + 1))
if [[ -f "$MONITOR" ]]; then
  echo -e "  ${GREEN}✓${NC} pipeline-monitor.sh exists"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✗${NC} pipeline-monitor.sh not found"
  FAIL=$((FAIL + 1))
fi

syntax_result=$(bash -n "$MONITOR" 2>&1)
assert_eq "pipeline-monitor.sh has valid syntax" "" "$syntax_result"

# ── Test 2: Version is 1.2.0 ────────────────────────────────────────
echo ""
echo "Test 2: version updated"

version=$(grep '^MONITOR_VERSION=' "$MONITOR" | head -1 | sed 's/.*"\(.*\)"/\1/')
assert_eq "monitor version is 1.2.0" "1.2.0" "$version"

# ── Test 3: Only 2 tabs (Tasks, Commands) ────────────────────────────
echo ""
echo "Test 3: tab structure"

max_tabs=$(grep '^MAX_TABS=' "$MONITOR" | head -1 | sed 's/MAX_TABS=//')
assert_eq "MAX_TABS is 2" "2" "$max_tabs"

file_contains "has Tasks tab label" "1:Tasks" "$MONITOR"
file_contains "has Commands tab label" "2:Commands" "$MONITOR"
file_not_contains "no Overview tab label" "1:Overview" "$MONITOR"
file_not_contains "no Activity tab label" "2:Activity" "$MONITOR"
file_not_contains "no Agents tab 3:" "3:Agents" "$MONITOR"
file_not_contains "no Stdout tab 4:" "4:Stdout" "$MONITOR"

# ── Test 4: AGENTS_VIEW_MODE state variable ─────────────────────────
echo ""
echo "Test 4: agents view mode"

file_contains "AGENTS_VIEW_MODE declared" "AGENTS_VIEW_MODE=false" "$MONITOR"
file_contains "render_agents_view_buf function exists" "render_agents_view_buf()" "$MONITOR"

# ── Test 5: Log view renders stdout (not task.md) ───────────────────
echo ""
echo "Test 5: log view shows stdout"

file_contains "stdout view function exists" "render_task_stdout_view_buf()" "$MONITOR"
file_contains "stdout view uses find_live_agent_info" "find_live_agent_info" "$MONITOR"

# ── Test 6: Commands tab content ─────────────────────────────────────
echo ""
echo "Test 6: commands tab"

file_contains "render_commands_tab function exists" "render_commands_tab()" "$MONITOR"
file_contains "has System Commands section" "System Commands" "$MONITOR"
file_contains "has Flow Shortcuts section" "Flow Shortcuts" "$MONITOR"
file_contains "has autotest shortcut" "autotest" "$MONITOR"

# ── Test 7: Key bindings ─────────────────────────────────────────────
echo ""
echo "Test 7: key bindings"

file_contains "a key for agents view" "AGENTS_VIEW_MODE=true" "$MONITOR"
file_contains "t key for autotest" "action_autotest false" "$MONITOR"
file_contains "T key for autotest smoke" "action_autotest true" "$MONITOR"
file_contains "tab keys limited to 1-2" '[1-2])' "$MONITOR"

# ── Test 8: action_autotest function ─────────────────────────────────
echo ""
echo "Test 8: autotest action"

file_contains "action_autotest function exists" "action_autotest()" "$MONITOR"
file_contains "autotest uses --smoke flag" '--smoke' "$MONITOR"
file_contains "autotest uses --start flag" '--start' "$MONITOR"

# ── Test 9: render dispatch only uses 2 tabs ─────────────────────────
echo ""
echo "Test 9: render dispatch"

render_block=$(sed -n '/^render() {/,/^}/p' "$MONITOR")
assert_contains "render dispatches to overview" "render_overview" "$render_block"
assert_contains "render dispatches to commands" "render_commands_tab" "$render_block"

# Check old tabs removed from dispatch — use grep -v to filter only render() block
TOTAL=$((TOTAL + 1))
if ! printf '%s' "$render_block" | grep -qF "render_logs_tab"; then
  echo -e "  ${GREEN}✓${NC} render does not dispatch to logs_tab"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✗${NC} render still dispatches to logs_tab"
  FAIL=$((FAIL + 1))
fi

TOTAL=$((TOTAL + 1))
if ! printf '%s' "$render_block" | grep -qF "render_stdout_tab"; then
  echo -e "  ${GREEN}✓${NC} render does not dispatch to stdout_tab"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✗${NC} render still dispatches to stdout_tab"
  FAIL=$((FAIL + 1))
fi

# ── Test 10: Format helpers ──────────────────────────────────────────
echo ""
echo "Test 10: format helpers"

# Source just the helpers (skip the main function and terminal-dependent parts)
eval "$(sed -n '/^format_duration()/,/^}/p' "$MONITOR")"
eval "$(sed -n '/^format_tokens()/,/^}/p' "$MONITOR")"

dur_30=$(format_duration 30)
assert_eq "format_duration 30s" "30s" "$dur_30"

dur_90=$(format_duration 90)
assert_eq "format_duration 90s = 1m 30s" "1m 30s" "$dur_90"

dur_3700=$(format_duration 3700)
assert_eq "format_duration 3700s = 1h 1m 40s" "1h 1m 40s" "$dur_3700"

tok_500=$(format_tokens 500)
assert_eq "format_tokens 500 = 500" "500" "$tok_500"

tok_1500=$(format_tokens 1500)
assert_eq "format_tokens 1500 = 1.5k" "1.5k" "$tok_1500"

tok_2500000=$(format_tokens 2500000)
assert_eq "format_tokens 2500000 = 2.5M" "2.5M" "$tok_2500000"

# ── Test 11: foundry_state_upsert_agent ──────────────────────────────
echo ""
echo "Test 11: state.json agents upsert"

tmp_root=$(mktemp -d)
trap 'rm -rf "$tmp_root"' EXIT

fake_task="$tmp_root/test-task--foundry"
mkdir -p "$fake_task"

# Create minimal state.json
cat > "$fake_task/state.json" <<'EOF'
{
  "task_id": "test-task--foundry",
  "workflow": "foundry",
  "status": "in_progress"
}
EOF

# Source common to get the function
# shellcheck disable=SC1090
source "$COMMON"
PIPELINE_TASKS_ROOT="$tmp_root"
FOUNDRY_TASK_ROOT="$tmp_root"

# Upsert an agent
foundry_state_upsert_agent "$fake_task" "coder" "done" "claude-opus" "120" "5000" "8000" "1.5" "1"

file_contains "state has agents array" '"agents"' "$fake_task/state.json"
file_contains "agent name is coder" '"agent": "coder"' "$fake_task/state.json"
file_contains "agent status is done" '"status": "done"' "$fake_task/state.json"
file_contains "agent model set" '"model": "claude-opus"' "$fake_task/state.json"
file_contains "agent duration set" '"duration_seconds": 120' "$fake_task/state.json"
file_contains "agent input_tokens set" '"input_tokens": 5000' "$fake_task/state.json"
file_contains "agent output_tokens set" '"output_tokens": 8000' "$fake_task/state.json"
file_contains "agent cost set" '"cost": 1.5' "$fake_task/state.json"
file_contains "agent call_count set" '"call_count": 1' "$fake_task/state.json"

# Upsert again with update
foundry_state_upsert_agent "$fake_task" "coder" "done" "claude-opus" "200" "10000" "15000" "3.0" "2"

file_contains "updated duration" '"duration_seconds": 200' "$fake_task/state.json"
file_contains "updated call_count" '"call_count": 2' "$fake_task/state.json"

# Check only one entry for coder
coder_count=$(python3 -c "
import json
data = json.load(open('$fake_task/state.json'))
print(sum(1 for a in data.get('agents', []) if a.get('agent') == 'coder'))
")
assert_eq "single coder entry after upsert" "1" "$coder_count"

# Add another agent with no data — should get n/d defaults
foundry_state_upsert_agent "$fake_task" "architect" "done" "" "" "" "" "" ""

file_contains "has architect" '"agent": "architect"' "$fake_task/state.json"
file_contains "architect model is n/d" '"model": "n/d"' "$fake_task/state.json"
file_contains "architect duration is n/d" '"duration_seconds": "n/d"' "$fake_task/state.json"
file_contains "architect input_tokens is n/d" '"input_tokens": "n/d"' "$fake_task/state.json"
file_contains "architect cost is n/d" '"cost": "n/d"' "$fake_task/state.json"

agent_count=$(python3 -c "
import json
data = json.load(open('$fake_task/state.json'))
print(len(data.get('agents', [])))
")
assert_eq "total 2 agents in state" "2" "$agent_count"

# ── Test 12: ESC resets all view modes ───────────────────────────────
echo ""
echo "Test 12: ESC handler resets all modes"

esc_block=$(grep -A5 'ESC|' "$MONITOR" | head -6)
assert_contains "ESC resets LOG_VIEW_MODE" "LOG_VIEW_MODE=false" "$esc_block"
assert_contains "ESC resets AGENTS_VIEW_MODE" "AGENTS_VIEW_MODE=false" "$esc_block"
assert_contains "ESC resets DETAIL_MODE" "DETAIL_MODE=false" "$esc_block"

# ── Test 13: q exits from agents view ────────────────────────────────
echo ""
echo "Test 13: q handler exits agents view"

q_block=$(sed -n '/q|Q)/,/;;/p' "$MONITOR" | head -10)
assert_contains "q checks AGENTS_VIEW_MODE" "AGENTS_VIEW_MODE" "$q_block"

# ── Test 14: foundry-common.sh syntax valid ──────────────────────────
echo ""
echo "Test 14: foundry-common.sh syntax"

common_syntax=$(bash -n "$COMMON" 2>&1)
assert_eq "foundry-common.sh has valid syntax" "" "$common_syntax"

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
