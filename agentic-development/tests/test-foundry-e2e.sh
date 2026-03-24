#!/usr/bin/env bash
#
# Tests for agentic-development/lib/foundry-e2e.sh
#
# Usage:
#   ./agentic-development/tests/test-foundry-e2e.sh
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
E2E_AUTOFIX="$REPO_ROOT/agentic-development/lib/foundry-e2e.sh"

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
  if echo "$haystack" | grep -q "$needle"; then
    echo -e "  ${GREEN}✓${NC} $desc"
    PASS=$((PASS + 1))
  else
    echo -e "  ${RED}✗${NC} $desc"
    echo "    expected to contain: $needle"
    echo "    actual: ${haystack:0:200}"
    FAIL=$((FAIL + 1))
  fi
}

echo ""
echo "foundry-e2e Tests"
echo "================="
echo ""

echo "Test 1: script exists"
TOTAL=$((TOTAL + 1))
if [[ -x "$E2E_AUTOFIX" ]]; then
  echo -e "  ${GREEN}✓${NC} foundry-e2e.sh is executable"
  PASS=$((PASS + 1))
else
  echo -e "  ${RED}✗${NC} foundry-e2e.sh not executable: $E2E_AUTOFIX"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "Test 2: parse report and create limited Foundry fix tasks"

tmp_root=$(mktemp -d)
trap 'rm -rf "$tmp_root"' EXIT
fake_tasks="$tmp_root/tasks"
fake_report="$tmp_root/report.json"

cat > "$fake_report" <<'EOF'
{
  "stats": { "tests": 3, "passes": 1, "failures": 3 },
  "failures": [
    {
      "title": "guest can open dashboard",
      "fullTitle": "Dashboard guest can open dashboard",
      "file": "tests/e2e/dashboard_test.js",
      "err": {
        "message": "expected 200 to equal 500",
        "stack": "AssertionError: expected 200 to equal 500\n    at Context.<anonymous> (tests/e2e/dashboard_test.js:10:5)"
      }
    },
    {
      "title": "knowledge search returns results",
      "fullTitle": "Knowledge knowledge search returns results",
      "file": "tests/e2e/knowledge_test.js",
      "err": {
        "message": "element \".knowledge-result\" not found",
        "stack": "Error: element \".knowledge-result\" not found\n    at Context.<anonymous> (tests/e2e/knowledge_test.js:22:7)"
      }
    },
    {
      "title": "guest can open dashboard",
      "fullTitle": "Dashboard guest can open dashboard",
      "file": "tests/e2e/dashboard_test.js",
      "err": {
        "message": "expected 200 to equal 500",
        "stack": "AssertionError: expected 200 to equal 500\n    at Context.<anonymous> (tests/e2e/dashboard_test.js:10:5)"
      }
    }
  ]
}
EOF

output=$(PIPELINE_TASKS_ROOT="$fake_tasks" "$E2E_AUTOFIX" --from-report "$fake_report" --limit 2 2>&1)
exit_code=$?
assert_eq "e2e-autofix exits 0 on parsed report" "0" "$exit_code"
assert_contains "command reports created tasks" "Created 2 Foundry fix task" "$output"

task_count=$(find "$fake_tasks" -maxdepth 1 -type d -name '*--foundry*' | wc -l | tr -d ' ')
assert_eq "creates exactly 2 unique tasks" "2" "$task_count"

first_task=$(find "$fake_tasks" -maxdepth 1 -type d -name '*--foundry*' | sort | head -n 1)
first_task_md=$(cat "$first_task/task.md")
first_state=$(python3 - "$first_task/state.json" <<'PYEOF'
import json
import sys
data = json.load(open(sys.argv[1], 'r', encoding='utf-8'))
print(data["status"])
print(data["workflow"])
PYEOF
)

assert_contains "task contains e2e source marker" "<!-- source: e2e-autofix -->" "$first_task_md"
assert_contains "task includes fix title prefix" "# Fix E2E failure:" "$first_task_md"
assert_contains "task references report path" "$fake_report" "$first_task_md"
assert_eq "new task state defaults pending" "pending" "$(echo "$first_state" | sed -n '1p')"
assert_eq "new task workflow is foundry" "foundry" "$(echo "$first_state" | sed -n '2p')"

echo ""
echo "Test 3: ignore non-JSON prefix lines before report payload"

fake_tasks_prefixed="$tmp_root/tasks-prefixed"
fake_prefixed_report="$tmp_root/report-prefixed.json"

cat > "$fake_prefixed_report" <<'EOF'
SKIP: service A unavailable
SKIP: service B unavailable
{
  "stats": { "tests": 1, "passes": 0, "failures": 1 },
  "failures": [
    {
      "title": "admin can save settings",
      "fullTitle": "Settings admin can save settings",
      "file": "tests/e2e/settings_test.js",
      "err": {
        "message": "expected success toast",
        "stack": "AssertionError: expected success toast"
      }
    }
  ]
}
EOF

prefixed_output=$(PIPELINE_TASKS_ROOT="$fake_tasks_prefixed" "$E2E_AUTOFIX" --from-report "$fake_prefixed_report" --limit 3 2>&1)
prefixed_exit=$?
prefixed_count=$(find "$fake_tasks_prefixed" -maxdepth 1 -type d -name '*--foundry*' | wc -l | tr -d ' ')

assert_eq "prefixed report still exits 0" "0" "$prefixed_exit"
assert_contains "prefixed report still creates tasks" "Created 1 Foundry fix task" "$prefixed_output"
assert_eq "prefixed report creates one task" "1" "$prefixed_count"

echo ""
echo "================="
echo -e "Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}, ${TOTAL} total"
echo ""

[[ $FAIL -eq 0 ]] && exit 0 || exit 1
