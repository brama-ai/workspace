#!/usr/bin/env bash
#
# Tests for Foundry state repair helpers in foundry-common.sh
#
# Usage:
#   ./agentic-development/tests/test-foundry-state.sh
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
echo "foundry state Tests"
echo "==================="
echo ""

tmp_root=$(mktemp -d)
trap 'rm -rf "$tmp_root"' EXIT
task_dir="$tmp_root/example-task--foundry"
mkdir -p "$task_dir"
printf '# Example task\n' > "$task_dir/task.md"
printf '{not-json\n' > "$task_dir/state.json"

echo "Test 1: foundry_set_state_status repairs invalid JSON"
foundry_set_state_status "$task_dir" "in_progress" "coder" "coder"
status=$(python3 - "$task_dir/state.json" <<'PYEOF'
import json, sys
data = json.load(open(sys.argv[1], 'r', encoding='utf-8'))
print(data["status"])
print(data["current_step"])
print(data["resume_from"])
print(data["workflow"])
print("ok" if data["attempt"] >= 1 else "bad")
PYEOF
)
assert_eq "status repaired to in_progress" "in_progress" "$(echo "$status" | sed -n '1p')"
assert_eq "current_step repaired to coder" "coder" "$(echo "$status" | sed -n '2p')"
assert_eq "resume_from repaired to coder" "coder" "$(echo "$status" | sed -n '3p')"
assert_eq "workflow normalized to foundry" "foundry" "$(echo "$status" | sed -n '4p')"
assert_eq "attempt normalized to >=1" "ok" "$(echo "$status" | sed -n '5p')"

echo ""
echo "Test 2: foundry_update_state_field preserves normalized schema"
printf '[]\n' > "$task_dir/state.json"
foundry_update_state_field "$task_dir" "branch" "pipeline/test-branch"
branch=$(python3 - "$task_dir/state.json" <<'PYEOF'
import json, sys
data = json.load(open(sys.argv[1], 'r', encoding='utf-8'))
print(data["branch"])
print(data["task_id"])
print(data["workflow"])
PYEOF
)
assert_eq "branch written after repair" "pipeline/test-branch" "$(echo "$branch" | sed -n '1p')"
assert_eq "task_id restored" "example-task--foundry" "$(echo "$branch" | sed -n '2p')"
assert_eq "workflow still foundry" "foundry" "$(echo "$branch" | sed -n '3p')"

echo ""
echo "Test 3: foundry_increment_attempt repairs bad attempt values"
printf '{"attempt": 0, "status": "pending"}\n' > "$task_dir/state.json"
foundry_increment_attempt "$task_dir"
attempt=$(python3 - "$task_dir/state.json" <<'PYEOF'
import json, sys
data = json.load(open(sys.argv[1], 'r', encoding='utf-8'))
print(data["attempt"])
print(data["status"])
PYEOF
)
assert_eq "attempt increments from repaired baseline" "2" "$(echo "$attempt" | sed -n '1p')"
assert_eq "status preserved across repair" "pending" "$(echo "$attempt" | sed -n '2p')"

echo ""
echo "==================="
echo -e "Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}, ${TOTAL} total"
echo ""

[[ $FAIL -eq 0 ]] && exit 0 || exit 1
