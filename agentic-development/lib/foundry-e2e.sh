#!/usr/bin/env bash
#
# Run E2E tests and generate Foundry bugfix tasks for failures.
#
set -euo pipefail

REPO_ROOT="${PIPELINE_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
# shellcheck source=/dev/null
source "$REPO_ROOT/agentic-development/lib/foundry-common.sh"

maybe_migrate_legacy_foundry_tasks
ensure_foundry_task_root
ensure_runtime_root

REPORT_DIR="$REPO_ROOT/.opencode/pipeline/reports"
LOG_DIR="$REPO_ROOT/.opencode/pipeline/logs"
mkdir -p "$REPORT_DIR" "$LOG_DIR"

SMOKE_MODE=false
AUTO_START=false
LIMIT=5
FROM_REPORT=""
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
RUN_LOG="$LOG_DIR/e2e-autofix-${TIMESTAMP}.log"
JSON_REPORT="$REPORT_DIR/e2e-autofix-${TIMESTAMP}.json"

show_help() {
  cat <<'EOF'
Usage:
  ./agentic-development/foundry.sh e2e-autofix [--smoke] [--limit N] [--start]
  ./agentic-development/foundry.sh e2e-autofix --from-report path/to/report.json [--limit N] [--start]
  ./agentic-development/foundry.sh autotest [N] [--smoke] [--start]

Options:
  --smoke              Run only @smoke E2E tests
  --limit N            Maximum fix tasks to create (default: 5)
  -n N                 Short alias for --limit
  --start              Start Foundry headless after creating tasks
  --from-report PATH   Parse an existing Codecept JSON report instead of running E2E
  -h, --help           Show this help
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --smoke) SMOKE_MODE=true; shift ;;
    --limit|-n) LIMIT="$2"; shift 2 ;;
    --start) AUTO_START=true; shift ;;
    --from-report) FROM_REPORT="$2"; shift 2 ;;
    -h|--help) show_help; exit 0 ;;
    ''|*[!0-9]*)
      echo "Unknown option: $1" >&2
      show_help >&2
      exit 1
      ;;
    *)
      LIMIT="$1"
      shift
      ;;
  esac
done

[[ "$LIMIT" =~ ^[0-9]+$ ]] || { echo "Invalid --limit: $LIMIT" >&2; exit 1; }
[[ "$LIMIT" -ge 1 ]] || { echo "--limit must be >= 1" >&2; exit 1; }

run_e2e_suite() {
  local e2e_dir="$REPO_ROOT/brama-core/tests/e2e"
  [[ -d "$e2e_dir" ]] || { echo "E2E directory not found: $e2e_dir" >&2; return 1; }

  {
    # Load devcontainer E2E env vars
    if [[ -f "$REPO_ROOT/.env.e2e.devcontainer" ]]; then
      # shellcheck disable=SC1091
      set -a; source "$REPO_ROOT/.env.e2e.devcontainer"; set +a
    fi
    export BASE_URL="${BASE_URL:-http://localhost:18080}"
    export CORE_DB_NAME="${CORE_DB_NAME:-brama_test}"
    export KNOWLEDGE_URL="${KNOWLEDGE_URL:-http://localhost:18083}"
    export NEWS_URL="${NEWS_URL:-http://localhost:18084}"
    export HELLO_URL="${HELLO_URL:-http://localhost:18085}"
    export OPENCLAW_URL="${OPENCLAW_URL:-http://localhost:28789}"

    # Quick health check — no docker build, no make e2e-prepare
    echo "==> E2E env-check"
    make -C "$REPO_ROOT" e2e-env-check || {
      echo "E2E stack not healthy. Start it first: make e2e-prepare" >&2
      return 1
    }

    # Ensure deps are present (fast if already installed)
    [[ -d "$e2e_dir/node_modules" ]] || (cd "$e2e_dir" && npm install)

    # Run with --steps for live terminal progress; capture full output for JSON parsing
    echo "==> codeceptjs run --steps"
    local e2e_exit=0
    (
      cd "$e2e_dir"
      local args=(npx codeceptjs run --steps)
      [[ "$SMOKE_MODE" == true ]] && args+=(--grep @smoke)
      "${args[@]}"
    ) || e2e_exit=$?

    # Parse codeceptjs output dir for failures (output/ has screenshots, logs)
    # Generate JSON report from a quick --reporter json re-run with --dry-run if available,
    # otherwise parse the step output we already have
    if [[ $e2e_exit -ne 0 ]]; then
      echo "==> E2E had failures (exit $e2e_exit) — generating JSON report for task creation"
      (
        cd "$e2e_dir"
        local args=(npx codeceptjs run --reporter json)
        [[ "$SMOKE_MODE" == true ]] && args+=(--grep @smoke)
        "${args[@]}"
      ) > "$JSON_REPORT" 2>/dev/null || true
    else
      echo "==> All E2E tests passed — no fix tasks needed"
      echo '{"stats":{"passes":0,"failures":0},"passes":[],"failures":[]}' > "$JSON_REPORT"
    fi

    echo "Report: $JSON_REPORT"
  } 2>&1 | tee "$RUN_LOG"
}

parse_failures() {
  _track_usage "parse_failures" "foundry-e2e.sh"
  local report_path="$1"
  python3 - "$report_path" "$LIMIT" <<'PYEOF'
import json
import sys
from pathlib import Path

report_path = Path(sys.argv[1])
limit = int(sys.argv[2])
raw = report_path.read_text(encoding="utf-8")
start = raw.find("{")
if start == -1:
    raise SystemExit(f"No JSON object found in report: {report_path}")

data = json.loads(raw[start:])

failures = data.get("failures")
if not isinstance(failures, list):
    failures = []

INFRA_PATTERNS = [
    "ERR_NAME_NOT_RESOLVED",
    "ENOTFOUND",
    "ECONNREFUSED",
    "net::ERR_CONNECTION_REFUSED",
    "net::ERR_CONNECTION_RESET",
    "net::ERR_NETWORK_CHANGED",
    "getaddrinfo",
]

def is_infra_failure(message):
    msg = message.lower()
    return any(p.lower() in msg for p in INFRA_PATTERNS)

def normalize_failure(entry):
    title = entry.get("fullTitle") or entry.get("title") or "Unnamed E2E failure"
    file_path = entry.get("file") or ""
    err = entry.get("err") or {}
    message = err.get("message") or entry.get("errMessage") or "No error message"
    stack = err.get("stack") or ""
    return {
        "title": title.strip(),
        "file": file_path.strip(),
        "message": str(message).strip(),
        "stack": str(stack).strip(),
    }

seen = set()
count = 0
skipped_infra = 0
for raw in failures:
    if count >= limit:
        break
    item = normalize_failure(raw)
    if is_infra_failure(item["message"]):
        skipped_infra += 1
        continue
    key = (item["title"], item["file"], item["message"])
    if key in seen:
        continue
    seen.add(key)
    print(json.dumps(item, ensure_ascii=True))
    count += 1

if skipped_infra:
    print(json.dumps({"_infra_skipped": skipped_infra}), file=sys.stderr)
PYEOF
}

create_fix_task() {
  _track_usage "create_fix_task" "foundry-e2e.sh"
  local failure_json="$1"
  local report_path="$2"
  local task_text
  task_text=$(python3 - "$failure_json" "$report_path" <<'PYEOF'
import json
import sys
from pathlib import Path

failure = json.loads(sys.argv[1])
report_path = sys.argv[2]
title = failure["title"]
safe_title = title[:120]
file_path = failure["file"] or "unknown"
message = failure["message"] or "No message"
stack = failure["stack"] or ""
stack_excerpt = "\n".join(stack.splitlines()[:20]).strip()

print(f"""<!-- priority: 3 -->
<!-- source: e2e-autofix -->
# Fix E2E failure: {safe_title}

Auto-generated Foundry bugfix task from E2E failure analysis.

## Failure

- Report: `{report_path}`
- Test file: `{file_path}`
- Scenario: `{title}`
- Message: `{message}`

## Required work

1. Reproduce the failing scenario locally from the E2E suite.
2. Determine whether the root cause is:
   - outdated/flaky E2E test code, selector, or timing
   - a real production bug in UI/backend/runtime
3. Implement the minimal fix.
4. Re-run the failing E2E and any impacted tests.
5. Document root cause and verification in handoff.

## Notes

- Keep scope limited to this failure unless a shared root cause clearly affects multiple failing tests.
- If the issue is pure infra flakiness, stabilize the test or document the blocker clearly.
""")

if stack_excerpt:
    print("\n## Stack excerpt\n")
    print("```text")
    print(stack_excerpt)
    print("```")
PYEOF
)

  foundry_create_task_dir "$task_text" >/dev/null
}

main() {
  local report_path="$FROM_REPORT"
  if [[ -z "$report_path" ]]; then
    echo "Running E2E suite..."
    if run_e2e_suite; then
      echo "E2E suite passed. No fix tasks created."
      return 0
    fi
    report_path="$JSON_REPORT"
    [[ -f "$report_path" ]] || { echo "E2E failed but JSON report not found: $report_path" >&2; return 1; }
  else
    [[ -f "$report_path" ]] || { echo "Report not found: $report_path" >&2; return 1; }
  fi

  local created=0
  local failure_json=""
  while IFS= read -r failure_json; do
    [[ -n "$failure_json" ]] || continue
    create_fix_task "$failure_json" "$report_path"
    created=$((created + 1))
  done < <(parse_failures "$report_path")

  if [[ "$created" -eq 0 ]]; then
    echo "No failing tests found in report. No tasks created."
    return 0
  fi

  echo "Created ${created} Foundry fix task(s)."

  if [[ "$AUTO_START" == true ]]; then
    "$REPO_ROOT/agentic-development/foundry.sh" headless
  fi
}

main
