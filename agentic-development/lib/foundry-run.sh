#!/usr/bin/env bash
#
# Multi-agent pipeline orchestrator for OpenCode.
#
# Runs pipeline agents in sequence:
#   1. Architect (Opus)      — creates OpenSpec proposal
#   2. Coder (Sonnet)        — implements the code
#   3. Auditor (optional)    — audits agent/platform compliance
#   4. Validator (Codex)     — runs PHPStan + CS, fixes issues
#   5. Tester (Codex)        — runs tests, fixes failures
#   6. Documenter (optional) — writes documentation
#   7. Summarizer (GPT-5.4)  — writes final task summary to tasks/<slug>--foundry/summary.md
#
# Usage:
#   ./scripts/pipeline.sh "Add streaming support to A2A gateway"
#   ./scripts/pipeline.sh --skip-architect "implement change add-a2a-streaming"
#   ./scripts/pipeline.sh --from coder "Continue implementing add-a2a-streaming"
#   ./scripts/pipeline.sh --only validator "Run PHPStan on core"
#   ./scripts/pipeline.sh --audit "Add feature X"
#   ./scripts/pipeline.sh --webhook https://hooks.slack.com/... "Task"
#
set -euo pipefail

# Allow override via env (used by foundry-batch.sh worktree mode)
REPO_ROOT="${PIPELINE_REPO_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
# shellcheck source=/dev/null
source "$REPO_ROOT/agentic-development/lib/foundry-common.sh"

# Debug trap: log where the script exits on error
if [[ "${FOUNDRY_DEBUG:-}" == "true" ]]; then
  trap 'debug_log "CRASH" "Script exited unexpectedly" "line=$LINENO" "exit_code=$?" "command=$BASH_COMMAND"' ERR
fi
ensure_foundry_task_root
PIPELINE_DIR="$REPO_ROOT/.opencode/pipeline"
LOG_DIR="$PIPELINE_DIR/logs"
REPORT_DIR="$PIPELINE_DIR/reports"
HANDOFF_LINK="$PIPELINE_DIR/handoff.md"       # symlink — agents always read this path
HANDOFF_TEMPLATE="$PIPELINE_DIR/handoff-template.md"
# Actual per-task handoff file is set in init_handoff()
HANDOFF_FILE=""
TIMESTAMP=$(date +%Y%m%d_%H%M%S)

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# Shared telemetry/cost helpers
# shellcheck source=/dev/null
source "$REPO_ROOT/agentic-development/lib/cost-tracker.sh"

# ── Event log (live activity feed for monitor) ────────────────────────
EVENT_LOG="$PIPELINE_DIR/events.log"

emit_event() {
  local event_type="$1"; shift
  local details="$*"
  local ts; ts=$(date '+%H:%M:%S')
  local epoch; epoch=$(date +%s)
  echo "${epoch}|${ts}|${event_type}|${details}" >> "$EVENT_LOG" 2>/dev/null || true
}

# Agent order
AGENTS=(u-architect u-coder u-validator u-tester u-summarizer)

# Timeouts per agent (seconds, override via env)
PIPELINE_TIMEOUT_INVESTIGATOR="${PIPELINE_TIMEOUT_INVESTIGATOR:-900}" # 15 min
PIPELINE_TIMEOUT_ARCHITECT="${PIPELINE_TIMEOUT_ARCHITECT:-2700}"   # 45 min
PIPELINE_TIMEOUT_CODER="${PIPELINE_TIMEOUT_CODER:-3600}"           # 60 min
PIPELINE_TIMEOUT_VALIDATOR="${PIPELINE_TIMEOUT_VALIDATOR:-1200}"   # 20 min
PIPELINE_TIMEOUT_TESTER="${PIPELINE_TIMEOUT_TESTER:-1800}"         # 30 min
PIPELINE_TIMEOUT_DOCUMENTER="${PIPELINE_TIMEOUT_DOCUMENTER:-900}"  # 15 min
PIPELINE_TIMEOUT_AUDITOR="${PIPELINE_TIMEOUT_AUDITOR:-1200}"       # 20 min
PIPELINE_TIMEOUT_E2E="${PIPELINE_TIMEOUT_E2E:-600}"               # 10 min
PIPELINE_TIMEOUT_MERGER="${PIPELINE_TIMEOUT_MERGER:-1200}"         # 20 min
PIPELINE_TIMEOUT_SUMMARIZER="${PIPELINE_TIMEOUT_SUMMARIZER:-900}"  # 15 min

# Retry config
MAX_RETRIES="${PIPELINE_MAX_RETRIES:-2}"
RETRY_DELAY="${PIPELINE_RETRY_DELAY:-30}"

# "cheap" virtual model — paid models under $1/1M tokens
# Override via: PIPELINE_CHEAP_MODELS="model1,model2"
CHEAP_MODELS="${PIPELINE_CHEAP_MODELS:-openrouter/deepseek-v3.2,openrouter/gemini-3.1-flash-lite}"

# "free" virtual model — expands to a chain of free models
# Override via: PIPELINE_FREE_MODELS="model1,model2,model3"
FREE_MODELS="${PIPELINE_FREE_MODELS:-opencode/big-pickle,opencode/gpt-5-nano}"

# Fallback model chains (override via env: PIPELINE_FALLBACK_ARCHITECT="model1,model2")
# Tiers: subscriptions (Claude+Codex) → free (OpenRouter) → cheap (paid per-token)
# Subscriptions already paid (flat rate), free costs nothing, cheap is last resort
# Fallback model chains: 5 fallbacks × 5 providers per agent
# Providers: anthropic, openai, google, opencode-go, opencode, openrouter
# Primary model (from agent .md) excluded; each fallback = different provider
#
# "free" expands to: opencode/big-pickle,opencode/gpt-5-nano
# "cheap" expands to: openrouter/deepseek-v3.2,openrouter/gemini-3.1-flash-lite
#
# Measured TTFO (2026-03-26): anthropic 6-7s, google 6s, minimax-coding-plan 7s, opencode-go 8s, opencode/free 12-19s
# openai/* may hit rate limits — stall detection handles fallback in ~12s
# Provider: minimax-coding-plan (NOT minimax/)
# Order: fastest (6-8s) → openai (may stall) → free tier last
FALLBACK_INVESTIGATOR="${PIPELINE_FALLBACK_INVESTIGATOR:-google/gemini-2.5-flash,minimax-coding-plan/MiniMax-M2.7,opencode-go/glm-5,openai/gpt-5.4,anthropic/claude-sonnet-4-6,opencode/big-pickle,openrouter/deepseek/deepseek-r1-0528-qwen3-8b:free}"
FALLBACK_ARCHITECT="${PIPELINE_FALLBACK_ARCHITECT:-google/gemini-2.5-flash,minimax-coding-plan/MiniMax-M2.7,opencode-go/glm-5,openai/gpt-5.4,anthropic/claude-sonnet-4-6,opencode/big-pickle,openrouter/deepseek/deepseek-r1-0528-qwen3-8b:free}"
FALLBACK_CODER="${PIPELINE_FALLBACK_CODER:-minimax-coding-plan/MiniMax-M2.7,opencode-go/glm-5,google/gemini-2.5-flash,openai/gpt-5.3-codex,anthropic/claude-sonnet-4-6,opencode/big-pickle,openrouter/qwen/qwen3-coder:free}"
FALLBACK_VALIDATOR="${PIPELINE_FALLBACK_VALIDATOR:-opencode-go/kimi-k2.5,google/gemini-2.5-flash,anthropic/claude-sonnet-4-6,openai/gpt-5.2,opencode/big-pickle,openrouter/deepseek/deepseek-r1-0528-qwen3-8b:free}"
FALLBACK_TESTER="${PIPELINE_FALLBACK_TESTER:-minimax-coding-plan/MiniMax-M2.7,anthropic/claude-sonnet-4-6,opencode-go/glm-5,openai/gpt-5.3-codex,google/gemini-2.5-flash,opencode/big-pickle,openrouter/qwen/qwen3-coder:free}"
FALLBACK_DOCUMENTER="${PIPELINE_FALLBACK_DOCUMENTER:-anthropic/claude-sonnet-4-6,minimax-coding-plan/MiniMax-M2.7,google/gemini-2.5-flash,openai/gpt-5.4,opencode-go/kimi-k2.5,opencode/big-pickle,openrouter/deepseek/deepseek-r1-0528-qwen3-8b:free}"
FALLBACK_AUDITOR="${PIPELINE_FALLBACK_AUDITOR:-minimax-coding-plan/MiniMax-M2.7,anthropic/claude-sonnet-4-6,opencode-go/glm-5,openai/gpt-5.4,google/gemini-2.5-flash,opencode/big-pickle,openrouter/deepseek/deepseek-r1-0528-qwen3-8b:free}"
FALLBACK_E2E="${PIPELINE_FALLBACK_E2E:-opencode-go/glm-5,minimax-coding-plan/MiniMax-M2.7,google/gemini-2.5-flash,openai/gpt-5.4,anthropic/claude-sonnet-4-6,opencode/big-pickle,openrouter/qwen/qwen3-coder:free}"
FALLBACK_MERGER="${PIPELINE_FALLBACK_MERGER:-minimax-coding-plan/MiniMax-M2.7,anthropic/claude-sonnet-4-6,opencode-go/glm-5,openai/gpt-5.4,google/gemini-2.5-flash,opencode/big-pickle,openrouter/deepseek/deepseek-r1-0528-qwen3-8b:free}"
FALLBACK_SUMMARIZER="${PIPELINE_FALLBACK_SUMMARIZER:-anthropic/claude-opus-4-6,minimax-coding-plan/MiniMax-M2.7,google/gemini-2.5-flash,openai/gpt-5.4,opencode-go/glm-5,opencode/big-pickle,openrouter/deepseek/deepseek-r1-0528:free}"

# ── Help ──────────────────────────────────────────────────────────────

show_help() {
  cat << 'HELP'
Usage: ./scripts/pipeline.sh [options] "task description"
       ./scripts/pipeline.sh [options] --task-file path/to/task.md

Options:
  --skip-architect    Skip the architect stage (use existing spec)
  --from <agent>      Start from a specific agent
  --only <agent>      Run only a specific agent
  --branch <name>     Use specific branch name (default: auto-generated)
  --task-file <path>  Read task prompt from a file instead of CLI argument
                      If file is used for Foundry, runtime materializes
                      tasks/<slug>--foundry/ and keeps state there
  --audit             Add auditor quality gate agent
  --webhook <url>     POST JSON summary to webhook on completion/failure
  --telegram          Send status updates via Telegram bot
  --no-commit         Skip auto-commits between agents
  --profile <name>    Use task profile: quick-fix, standard, complex
  --skip-planner      Skip the planner agent (use default pipeline)
  --skip-env-check    Skip environment prerequisites check
  -h, --help          Show this help

Agents: u-planner, u-investigator, u-architect, u-coder, u-auditor, u-validator, u-tester, e2e, u-merger, u-documenter, u-translater, u-summarizer

Profiles:
  quick-fix    — u-coder + u-validator + u-summarizer
  standard     — u-architect + u-coder + u-validator + u-tester + u-summarizer
  complex      — standard + u-auditor + extended timeouts
  bugfix       — u-investigator + u-coder + u-validator + u-tester + u-summarizer
  bugfix+spec  — u-investigator + u-architect + u-coder + u-validator + u-tester + u-summarizer
  merge        — u-merger + u-summarizer
  merge+test   — u-merger + u-tester + u-summarizer
  merge+deploy — u-merger + u-tester + u-deployer + u-summarizer

Timeouts (override via env):
  PIPELINE_TIMEOUT_PLANNER=300     (5 min)
  PIPELINE_TIMEOUT_INVESTIGATOR=900 (15 min)
  PIPELINE_TIMEOUT_ARCHITECT=2700  (45 min)
  PIPELINE_TIMEOUT_CODER=3600     (60 min)
  PIPELINE_TIMEOUT_VALIDATOR=1200 (20 min)
  PIPELINE_TIMEOUT_TESTER=1800   (30 min)
  PIPELINE_TIMEOUT_MERGER=1200   (20 min)
  PIPELINE_TIMEOUT_DOCUMENTER=900 (15 min)
  PIPELINE_TIMEOUT_SUMMARIZER=900 (15 min)
  PIPELINE_MAX_RETRIES=2

Token budgets (override via env, 0=unlimited):
  PIPELINE_TOKEN_BUDGET_PLANNER=100000
  PIPELINE_TOKEN_BUDGET_ARCHITECT=500000
  PIPELINE_TOKEN_BUDGET_CODER=2000000
  PIPELINE_TOKEN_BUDGET_SUMMARIZER=300000
  PIPELINE_MAX_COST=<max total cost in USD>
  PIPELINE_RETRY_DELAY=30

Telegram (env vars):
  PIPELINE_TELEGRAM_BOT_TOKEN    Bot API token
  PIPELINE_TELEGRAM_CHAT_ID      Chat/group ID to post to

Fallback models (env vars, comma-separated):
  Tiers: subscriptions (Claude+Codex) → free → cheap (per-token)
  PIPELINE_FALLBACK_INVESTIGATOR (default: gpt-5.4,glm-5,M2.7,gemini,big-pickle,free)
  PIPELINE_FALLBACK_ARCHITECT    (default: gpt-5.4,glm-5,M2.7,gemini,big-pickle,free)
  PIPELINE_FALLBACK_CODER        (default: M2.7,gpt-5.3-codex,glm-5,gemini,big-pickle,qwen3-coder:free)
  PIPELINE_FALLBACK_VALIDATOR    (default: gpt-5.2,kimi-k2.5,minimax-m2.5-free,gemini-flash-lite,deepseek:free)
  PIPELINE_FALLBACK_TESTER       (default: gpt-5.3-codex,M2.7-highspeed,big-pickle,gemini,qwen3-coder:free)
  PIPELINE_FALLBACK_DOCUMENTER   (default: sonnet,gemini-flash,M2.5,kimi,big-pickle,free)
  PIPELINE_FALLBACK_SUMMARIZER   (default: opus,gemini-pro,M2.7,glm-5,big-pickle,deepseek:free)
  PIPELINE_CHEAP_MODELS          (default: deepseek-v3.2,gemini-3.1-flash-lite)
  PIPELINE_FREE_MODELS           (default: big-pickle,gpt-5-nano,minimax-m2.5-free)

Examples:
  ./scripts/pipeline.sh "Add streaming support to A2A"
  ./scripts/pipeline.sh --skip-architect "Implement openspec change add-a2a-streaming"
  ./scripts/pipeline.sh --from validator "Fix validation issues"
  ./scripts/pipeline.sh --only tester "Run tests for hello-agent"
  ./scripts/pipeline.sh --audit "Add feature with quality gate"
  ./scripts/pipeline.sh --only summarizer --task-file /absolute/path/to/example.md
HELP
}

# Parse arguments
SKIP_ARCHITECT=false
FROM_AGENT=""
ONLY_AGENT=""
BRANCH_NAME=""
TASK_MESSAGE=""
TASK_FILE=""
WEBHOOK_URL=""
ENABLE_AUDIT=false
NO_COMMIT=false
RESUME_MODE=false
TELEGRAM_NOTIFY=false
TELEGRAM_BOT_TOKEN="${PIPELINE_TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT_ID="${PIPELINE_TELEGRAM_CHAT_ID:-}"
PIPELINE_PROFILE=""
SKIP_PLANNER=false
SKIP_ENV_CHECK=false

# Pipeline cost budget (empty = unlimited)
PIPELINE_MAX_COST="${PIPELINE_MAX_COST:-}"

# Per-agent token tracking via temp files (bash 3.x has no associative arrays)
AGENT_TOKENS_DIR="/tmp/pipeline_tokens_$$"
mkdir -p "$AGENT_TOKENS_DIR"
set_agent_tokens() { echo "$2" > "$AGENT_TOKENS_DIR/$1"; }
get_agent_tokens() { cat "$AGENT_TOKENS_DIR/$1" 2>/dev/null || echo "{}"; }

# Per-agent token budgets (0 = unlimited)
PIPELINE_TOKEN_BUDGET_PLANNER="${PIPELINE_TOKEN_BUDGET_PLANNER:-100000}"
PIPELINE_TOKEN_BUDGET_INVESTIGATOR="${PIPELINE_TOKEN_BUDGET_INVESTIGATOR:-300000}"
PIPELINE_TOKEN_BUDGET_ARCHITECT="${PIPELINE_TOKEN_BUDGET_ARCHITECT:-500000}"
PIPELINE_TOKEN_BUDGET_CODER="${PIPELINE_TOKEN_BUDGET_CODER:-2000000}"
PIPELINE_TOKEN_BUDGET_VALIDATOR="${PIPELINE_TOKEN_BUDGET_VALIDATOR:-500000}"
PIPELINE_TOKEN_BUDGET_TESTER="${PIPELINE_TOKEN_BUDGET_TESTER:-500000}"
PIPELINE_TOKEN_BUDGET_DOCUMENTER="${PIPELINE_TOKEN_BUDGET_DOCUMENTER:-300000}"
PIPELINE_TOKEN_BUDGET_AUDITOR="${PIPELINE_TOKEN_BUDGET_AUDITOR:-300000}"
PIPELINE_TOKEN_BUDGET_E2E="${PIPELINE_TOKEN_BUDGET_E2E:-300000}"
PIPELINE_TOKEN_BUDGET_SUMMARIZER="${PIPELINE_TOKEN_BUDGET_SUMMARIZER:-300000}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-architect)
      SKIP_ARCHITECT=true
      shift
      ;;
    --from)
      FROM_AGENT="$2"
      shift 2
      ;;
    --only)
      ONLY_AGENT="$2"
      shift 2
      ;;
    --branch)
      BRANCH_NAME="$2"
      shift 2
      ;;
    --webhook)
      WEBHOOK_URL="$2"
      shift 2
      ;;
    --audit)
      ENABLE_AUDIT=true
      shift
      ;;
    --task-file)
      TASK_FILE="$2"
      shift 2
      ;;
    --resume)
      RESUME_MODE=true
      shift
      ;;
    --no-commit)
      NO_COMMIT=true
      shift
      ;;
    --telegram)
      TELEGRAM_NOTIFY=true
      shift
      ;;
    --profile)
      PIPELINE_PROFILE="$2"
      shift 2
      ;;
    --skip-planner)
      SKIP_PLANNER=true
      shift
      ;;
    --skip-env-check)
      SKIP_ENV_CHECK=true
      shift
      ;;
    --help|-h)
      show_help
      exit 0
      ;;
    *)
      TASK_MESSAGE="$1"
      shift
      ;;
  esac
done

# Load task from file if --task-file was specified
if [[ -n "$TASK_FILE" ]]; then
  if [[ ! -f "$TASK_FILE" ]]; then
    echo -e "${RED}Error: Task file not found: ${TASK_FILE}${NC}"
    exit 1
  fi
  TASK_MESSAGE=$(cat "$TASK_FILE")
fi

if [[ -z "$TASK_MESSAGE" ]]; then
  show_help
  exit 1
fi

# Generate slug from task message (first # title line only)
_task_slug() {
  local text="$1"
  # Extract first # heading as title
  local title
  title=$(echo "$text" | grep -m1 '^# ' | sed 's/^# //')
  if [[ -z "$title" ]]; then
    # Fallback: first non-empty line
    title=$(echo "$text" | grep -m1 '[^ ]')
  fi
  local slug
  slug=$(echo "$title" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//' | sed 's/-$//' | cut -c1-50)
  # If slug is empty (non-ASCII title), use task file basename
  if [[ -z "$slug" && -n "$TASK_FILE" ]]; then
    slug=$(basename "$TASK_FILE" .md)
  fi
  # Ultimate fallback
  if [[ -z "$slug" ]]; then
    slug="task-$(date +%s)"
  fi
  echo "$slug"
}

# ── Task file lifecycle (Foundry task root integration) ─────────────
# When --task-file points to tasks/<slug>--foundry/task.md, manage its lifecycle
# so the Foundry monitor can track progress in real time.
TASK_LIFECYCLE=false
TASK_ACTIVE_FILE=""
TASKS_DIR=""
TASK_DIR=""

_detect_task_lifecycle() {
  if [[ -n "$TASK_FILE" ]]; then
    local task_dir=""
    task_dir=$(foundry_task_dir_from_file "$TASK_FILE" 2>/dev/null || true)
    if [[ -n "$task_dir" ]]; then
      TASK_LIFECYCLE=true
      TASK_DIR="$task_dir"
      TASKS_DIR="$PIPELINE_TASKS_ROOT"
      TASK_FILE="$task_dir/task.md"
    fi
  else
    local slug
    slug=$(_task_slug "$TASK_MESSAGE")
    TASK_DIR=$(foundry_task_dir_for_slug "$slug" || true)
    if [[ -z "$TASK_DIR" ]]; then
      TASK_DIR=$(foundry_create_task_dir "$TASK_MESSAGE" "$slug")
    fi
    TASK_FILE="$(foundry_task_file "$TASK_DIR")"
    TASK_LIFECYCLE=true
    TASKS_DIR="$PIPELINE_TASKS_ROOT"
    foundry_set_state_status "$TASK_DIR" "pending" "" ""
    pipeline_task_append_event "$TASK_DIR" "task_created" "Foundry task initialized"
  fi
}

_task_move_to_in_progress() {
  [[ "$TASK_LIFECYCLE" != true ]] && return
  TASK_ACTIVE_FILE="$TASK_FILE"

  # Safe Start Protocol: Run preflight checks before transitioning to in_progress
  if [[ -f "$REPO_ROOT/agentic-development/lib/foundry-preflight.sh" ]]; then
    # shellcheck source=/dev/null
    source "$REPO_ROOT/agentic-development/lib/foundry-preflight.sh"

    echo -e "${BOLD}Running Safe Start preflight checks...${NC}"
    if ! foundry_preflight_check "$TASK_DIR" "default"; then
      echo -e "${RED}✗ Preflight checks failed - task stopped${NC}"
      local stop_reason
      stop_reason=$(foundry_state_field "$TASK_DIR" stop_reason 2>/dev/null || echo "unknown")
      echo -e "${YELLOW}  Stop reason: $stop_reason${NC}"
      echo -e "${YELLOW}  See handoff.md for recovery instructions${NC}"
      echo -e "${YELLOW}  Resume with: ./agentic-development/foundry.sh resume $(basename "$TASK_DIR")${NC}"
      exit 1
    fi
    echo -e "${GREEN}✓ Preflight checks passed${NC}"
  fi

  foundry_set_state_status "$TASK_DIR" "in_progress" "${FROM_AGENT:-u-planner}" "${FROM_AGENT:-u-planner}"
  pipeline_task_append_event "$TASK_DIR" "run_started" "Foundry run started" "${FROM_AGENT:-u-planner}"
  echo -e "${BLUE}Task state: pending → in_progress${NC}"
}

_task_move_to_done() {
  [[ "$TASK_LIFECYCLE" != true ]] && return
  local branch="${1:-}"
  foundry_set_state_status "$TASK_DIR" "completed" "" ""
  [[ -n "$branch" ]] && foundry_update_state_field "$TASK_DIR" "branch" "$branch"
  pipeline_task_append_event "$TASK_DIR" "run_completed" "Foundry run completed" "u-summarizer"
  echo -e "${GREEN}Task state: in_progress → completed${NC}"
}

_task_move_to_failed() {
  [[ "$TASK_LIFECYCLE" != true ]] && return
  local branch="${1:-}"
  foundry_set_state_status "$TASK_DIR" "failed" "${failed_agent:-unknown}" "${failed_agent:-u-coder}"
  [[ -n "$branch" ]] && foundry_update_state_field "$TASK_DIR" "branch" "$branch"
  pipeline_task_append_event "$TASK_DIR" "run_failed" "Foundry run failed at ${failed_agent:-unknown}" "${failed_agent:-unknown}"
  echo -e "${RED}Task state: in_progress → failed${NC}"
}

_detect_task_lifecycle

TASK_SLUG=""
if [[ -n "$TASK_DIR" ]]; then
  TASK_SLUG=$(foundry_task_slug_from_dir "$TASK_DIR")
fi

_is_autotest_task() {
  [[ "$TASK_MESSAGE" == *"<!-- source: autotest -->"* || "$TASK_MESSAGE" == *$'\n# Admin created task '* || "$TASK_MESSAGE" == "# Admin created task "* ]]
}

_skip_autotest_task() {
  echo -e "${YELLOW}Autotest task detected — skipping pipeline and marking as done.${NC}"
  _task_move_to_in_progress
  _task_move_to_done "autotest/skipped" "0"
  exit 0
}

if _is_autotest_task; then
  _skip_autotest_task
fi

# ── Pre-flight checks ────────────────────────────────────────────────

preflight() {
  echo -e "${BOLD}Pre-flight checks...${NC}"
  local errors=0

  # 1. opencode CLI
  if ! command -v opencode &>/dev/null; then
    echo -e "  ${RED}✗ opencode CLI not found${NC}"
    errors=$((errors + 1))
  else
    echo -e "  ${GREEN}✓ opencode $(opencode --version 2>/dev/null)${NC}"
  fi

  # 2. Docker daemon (optional - only required for tests)
  if ! command -v docker &>/dev/null; then
    echo -e "  ${YELLOW}⚠ Docker not installed (tests will be skipped)${NC}"
  elif ! docker info &>/dev/null; then
    echo -e "  ${YELLOW}⚠ Docker daemon not running (tests will be skipped)${NC}"
  else
    echo -e "  ${GREEN}✓ Docker daemon${NC}"
  fi

  # 3. Key services (postgres, redis)
  if docker info &>/dev/null; then
    if docker compose -f "$REPO_ROOT/compose.yaml" ps --format json 2>/dev/null | grep -q '"running"'; then
      echo -e "  ${GREEN}✓ Docker stack running${NC}"

      # Postgres connectivity
      if docker compose -f "$REPO_ROOT/compose.yaml" exec -T postgres pg_isready -q 2>/dev/null; then
        echo -e "  ${GREEN}✓ Postgres accepting connections${NC}"
      else
        echo -e "  ${YELLOW}⚠ Postgres not ready (tests may fail)${NC}"
      fi
    else
      echo -e "  ${YELLOW}⚠ Docker stack may not be running (run 'make up' first)${NC}"
    fi
  fi

  # 4. Git state
  if ! git -C "$REPO_ROOT" rev-parse --git-dir &>/dev/null; then
    echo -e "  ${RED}✗ Not a git repository${NC}"
    errors=$((errors + 1))
  else
    if [[ -n "$(git -C "$REPO_ROOT" status --porcelain 2>/dev/null)" ]]; then
      echo -e "  ${YELLOW}⚠ Git working tree has uncommitted changes${NC}"
      # Block if openspec/ files have uncommitted changes (P1 sync guard)
      local openspec_dirty
      openspec_dirty=$(git -C "$REPO_ROOT" status --porcelain -- openspec/ 2>/dev/null || true)
      if [[ -n "$openspec_dirty" ]]; then
        echo -e "  ${RED}✗ openspec/ has uncommitted changes — commit them first${NC}"
        echo -e "  ${RED}  Pipeline branches from HEAD; uncommitted specs won't be included${NC}"
        echo "$openspec_dirty" | while IFS= read -r line; do
          echo -e "    ${RED}${line}${NC}"
        done
        errors=$((errors + 1))
      fi
    else
      echo -e "  ${GREEN}✓ Git working tree clean${NC}"
    fi
  fi

  # 5. Required tools
  for cmd in timeout jq; do
    if command -v "$cmd" &>/dev/null; then
      echo -e "  ${GREEN}✓ ${cmd}${NC}"
    else
      echo -e "  ${YELLOW}⚠ ${cmd} not found (some features disabled)${NC}"
    fi
  done

  echo ""

  if [[ $errors -gt 0 ]]; then
    echo -e "${RED}Pre-flight failed with ${errors} error(s). Aborting.${NC}"
    exit 1
  fi
}

# ── Environment check ────────────────────────────────────────────────

env_check() {
  if [[ "$SKIP_ENV_CHECK" == true ]]; then
    echo -e "${YELLOW}⚠ Environment check skipped (--skip-env-check)${NC}"
    return 0
  fi

  local env_check_script="$REPO_ROOT/agentic-development/lib/env-check.sh"
  if [[ ! -x "$env_check_script" ]]; then
    echo -e "${YELLOW}⚠ env-check.sh not found or not executable — skipping environment check${NC}"
    return 0
  fi

  echo -e "${BOLD}Environment check...${NC}"

  # Build --app flags from task context (detect apps mentioned in task message)
  local app_flags=()
  local task_lower
  task_lower=$(echo "$TASK_MESSAGE" | tr '[:upper:]' '[:lower:]')
  [[ "$task_lower" == *"core"* ]]               && app_flags+=("--app" "core")
  [[ "$task_lower" == *"knowledge"* ]]           && app_flags+=("--app" "knowledge-agent")
  [[ "$task_lower" == *"dev-reporter"* ]]        && app_flags+=("--app" "dev-reporter-agent")
  [[ "$task_lower" == *"news-maker"* || "$task_lower" == *"news_maker"* ]] && app_flags+=("--app" "news-maker-agent")
  [[ "$task_lower" == *"wiki"* ]]                && app_flags+=("--app" "wiki-agent")

  local env_report_file="$PIPELINE_DIR/env-report.json"
  local env_exit_code=0

  "$env_check_script" "${app_flags[@]+"${app_flags[@]}"}" \
    --report-file "$env_report_file" \
    2>&1 || env_exit_code=$?

  if [[ $env_exit_code -eq 2 ]]; then
    # Fatal: cancel pipeline
    emit_event "ENV_FATAL" "report=${env_report_file}"
    echo -e "${RED}${BOLD}Environment check FATAL — pipeline cancelled.${NC}"
    echo -e "${RED}Fix the issues above and retry.${NC}"
    send_telegram "🔴 <b>ENV_FATAL: Pipeline cancelled</b>
📋 <i>${TASK_MESSAGE}</i>
⚠️ Fatal environment prerequisites missing. Check env-report.json."
    _task_move_to_failed "env-fatal" "0"
    exit 3
  elif [[ $env_exit_code -eq 1 ]]; then
    # Warnings: continue but note in handoff
    emit_event "ENV_WARN" "report=${env_report_file}"
    echo -e "${YELLOW}⚠ Environment warnings detected — pipeline continues with degraded capability.${NC}"
    # Write warnings to handoff if it exists
    if [[ -f "$HANDOFF_FILE" ]]; then
      {
        echo ""
        echo "## Environment"
        echo ""
        echo "- **Status**: warnings (exit 1)"
        echo "- **Report**: ${env_report_file}"
        if command -v jq &>/dev/null && [[ -f "$env_report_file" ]]; then
          echo "- **Summary**: $(jq -r '.summary // "unknown"' "$env_report_file" 2>/dev/null)"
          echo "- **Warnings**:"
          jq -r '.checks[] | select(.status == "warn") | "  - \(.name): \(.detail)"' "$env_report_file" 2>/dev/null || true
        fi
      } >> "$HANDOFF_FILE"
    fi
  else
    # All pass: write env versions to handoff
    emit_event "ENV_PASS" "report=${env_report_file}"
    if [[ -f "$HANDOFF_FILE" ]]; then
      {
        echo ""
        echo "## Environment"
        echo ""
        echo "- **Status**: pass"
        echo "- **Report**: ${env_report_file}"
        if command -v jq &>/dev/null && [[ -f "$env_report_file" ]]; then
          echo "- **Summary**: $(jq -r '.summary // "unknown"' "$env_report_file" 2>/dev/null)"
          echo "- **Versions**:"
          jq -r '.environment | to_entries[] | select(.value != "") | "  - \(.key): \(.value)"' "$env_report_file" 2>/dev/null || true
        fi
      } >> "$HANDOFF_FILE"
    fi
  fi
}

# ── Setup directories ─────────────────────────────────────────────────

mkdir -p "$LOG_DIR" "$REPORT_DIR"

# ── Determine which agents to run ─────────────────────────────────────

get_agents_to_run() {
  local agent_list=("${AGENTS[@]}")

  # Add auditor if enabled and not already present. Keep it after coder.
  if [[ "$ENABLE_AUDIT" == true ]]; then
    local has_auditor=false
    local new_list=()
    for agent in "${agent_list[@]}"; do
      [[ "$agent" == "u-auditor" ]] && has_auditor=true
    done
    if [[ "$has_auditor" != true ]]; then
      for agent in "${agent_list[@]}"; do
        new_list+=("$agent")
        if [[ "$agent" == "u-coder" ]]; then
          new_list+=("u-auditor")
        fi
      done
      agent_list=("${new_list[@]}")
    fi
  fi

  if [[ -n "$ONLY_AGENT" ]]; then
    echo "$ONLY_AGENT"
    return
  fi

  local has_summarizer=false
  for agent in "${agent_list[@]}"; do
    [[ "$agent" == "u-summarizer" ]] && has_summarizer=true
  done
  if [[ "$has_summarizer" != true ]]; then
    agent_list+=("u-summarizer")
  fi

  local started=false
  for agent in "${agent_list[@]}"; do
    if [[ -n "$FROM_AGENT" ]]; then
      if [[ "$agent" == "$FROM_AGENT" ]]; then
        started=true
      fi
      if ! $started; then
        continue
      fi
    fi

    if [[ "$SKIP_ARCHITECT" == true && "$agent" == "u-architect" ]]; then
      continue
    fi

    echo "$agent"
  done
}

# ── Git branch setup ──────────────────────────────────────────────────

setup_branch() {
  if [[ -n "$BRANCH_NAME" ]]; then
    echo "$BRANCH_NAME"
  else
    local slug="${TASK_SLUG:-$(_task_slug "$TASK_MESSAGE")}"
    echo "pipeline/${slug}"
  fi
}

# ── Get timeout for agent ─────────────────────────────────────────────

get_timeout() {
  local agent="$1"
  # Strip u-/s- prefix for timeout var lookup (u-architect → ARCHITECT)
  local base_name="${agent#u-}"
  base_name="${base_name#s-}"
  local var_name="PIPELINE_TIMEOUT_$(echo "$base_name" | tr '[:lower:]' '[:upper:]' | tr '-' '_')"
  echo "${!var_name:-1800}"
}

# ── Commit agent work ─────────────────────────────────────────────────

commit_agent_work() {
  local agent="$1"
  local task_slug="$2"

  if [[ "$NO_COMMIT" == true ]]; then
    return 0
  fi

  # Check if there are changes to commit
  if git -C "$REPO_ROOT" diff --quiet && git -C "$REPO_ROOT" diff --cached --quiet && [[ -z "$(git -C "$REPO_ROOT" ls-files --others --exclude-standard)" ]]; then
    echo -e "  ${BLUE}No changes to commit after ${agent}${NC}"
    return 0
  fi

  git -C "$REPO_ROOT" add -A
  if [[ -n "${TASK_DIR:-}" ]]; then
    git -C "$REPO_ROOT" add -f "${TASK_DIR#"$REPO_ROOT"/}/summary.md" 2>/dev/null || true
    git -C "$REPO_ROOT" add -f "${TASK_DIR#"$REPO_ROOT"/}/state.json" 2>/dev/null || true
    git -C "$REPO_ROOT" add -f "${TASK_DIR#"$REPO_ROOT"/}/handoff.md" 2>/dev/null || true
    git -C "$REPO_ROOT" add -f "${TASK_DIR#"$REPO_ROOT"/}/meta.json" 2>/dev/null || true
    git -C "$REPO_ROOT" add -f "${TASK_DIR#"$REPO_ROOT"/}/events.jsonl" 2>/dev/null || true
  fi
  local commit_msg="[pipeline:${agent}] ${task_slug}"

  if git -C "$REPO_ROOT" commit -m "$commit_msg" --no-verify 2>/dev/null; then
    local hash
    hash=$(git -C "$REPO_ROOT" rev-parse --short HEAD)
    echo -e "  ${GREEN}✓ Committed: ${hash} — ${commit_msg}${NC}"

    # Update handoff with commit hash
    if [[ -f "$HANDOFF_FILE" ]]; then
      # Append commit info to the agent's section
      echo "- **Commit (${agent})**: ${hash}" >> "$HANDOFF_FILE"
    fi
    return 0
  else
    echo -e "  ${YELLOW}⚠ Commit failed (may have no changes)${NC}"
    return 0
  fi
}

# ── Checkpoint & Artifacts ────────────────────────────────────────────
#
# Each task gets an artifacts directory inside tasks/<slug>--foundry/artifacts/
# Inside:
#   checkpoint.json  — tracks which agents completed successfully
#   <agent>/         — agent-specific artifacts (logs, proposals, etc.)
#
# checkpoint.json format:
# {
#   "task": "...", "branch": "...", "started": "...",
#   "agents": {
#     "architect": {"status":"done","duration":123,"commit":"abc1234"},
#     "coder": {"status":"done","duration":456,"commit":"def5678"}
#   }
# }

ARTIFACTS_BASE="$FOUNDRY_TASK_ROOT"

# Initialize artifacts directory for a task
init_artifacts() {
  local slug="$1"
  local branch="$2"
  if [[ -z "$TASK_DIR" ]]; then
    TASK_DIR=$(foundry_task_dir_for_slug "$slug" || true)
  fi
  if [[ -z "$TASK_DIR" ]]; then
    TASK_DIR=$(foundry_create_task_dir "$TASK_MESSAGE" "$slug")
    TASK_FILE="$(foundry_task_file "$TASK_DIR")"
    TASK_LIFECYCLE=true
  fi
  ARTIFACTS_DIR="$(foundry_artifacts_dir "$TASK_DIR")"
  CHECKPOINT_FILE="$(foundry_checkpoint_file "$TASK_DIR")"
  TELEMETRY_DIR="$(foundry_telemetry_dir "$TASK_DIR")"
  TASK_SUMMARY_DIR="$TASK_DIR"
  TASK_SUMMARY_FILE="$(foundry_summary_file "$TASK_DIR")"

  mkdir -p "$ARTIFACTS_DIR"
  mkdir -p "$TELEMETRY_DIR"
  mkdir -p "$TASK_SUMMARY_DIR"

  # Only create new checkpoint if not resuming
  if [[ "$RESUME_MODE" == true && -f "$CHECKPOINT_FILE" ]]; then
    echo -e "${BLUE}Resuming from checkpoint: ${CHECKPOINT_FILE}${NC}"
    return
  fi

  # Create fresh checkpoint
  local task_escaped
  task_escaped=$(printf '%s' "$TASK_MESSAGE" | jq -Rs .)
  cat > "$CHECKPOINT_FILE" << CHECKPOINT_EOF
{
  "task": $task_escaped,
  "branch": "$branch",
  "workflow": "foundry",
  "started": "$(date '+%Y-%m-%d %H:%M:%S')",
  "agents": {}
}
CHECKPOINT_EOF
  foundry_update_state_field "$TASK_DIR" "branch" "$branch"
}

set_planned_agents() {
  [[ -f "$CHECKPOINT_FILE" ]] || return 0
  local agents_json
  agents_json=$(printf '%s\n' "$@" | jq -R . | jq -s .)
  local tmp="${CHECKPOINT_FILE}.tmp"
  jq --argjson planned "$agents_json" '.planned_agents = $planned' "$CHECKPOINT_FILE" > "$tmp" && mv "$tmp" "$CHECKPOINT_FILE"
}

write_checkpoint() {
  local agent="$1"
  local status="$2"
  local duration="${3:-0}"
  local commit_hash="${4:-}"
  local tokens_json="${5:-{}}"
  local actual_model="${6:-$(get_current_model "$agent" 2>/dev/null || echo "unknown")}"

  [[ -f "$CHECKPOINT_FILE" ]] || return 0

  # Sanitize inputs for jq --argjson (must be valid JSON numbers/objects)
  [[ "$duration" =~ ^[0-9]+$ ]] || duration=0
  echo "$tokens_json" | jq . >/dev/null 2>&1 || tokens_json='{}'

  local finished
  finished=$(date '+%Y-%m-%d %H:%M:%S')
  local tmp="${CHECKPOINT_FILE}.tmp"

  jq --arg agent "$agent" \
     --arg status "$status" \
     --arg model "$actual_model" \
     --argjson duration "$duration" \
     --arg commit "$commit_hash" \
     --arg finished "$finished" \
     --argjson tokens "$tokens_json" \
     '.agents[$agent] = {status: $status, model: $model, duration: $duration, commit: $commit, finished: $finished, tokens: $tokens}' \
     "$CHECKPOINT_FILE" > "$tmp" && mv "$tmp" "$CHECKPOINT_FILE"
}

# Copy agent log to artifacts
save_agent_artifact() {
  local agent="$1"
  local log_file="$2"

  [[ -d "$ARTIFACTS_DIR" ]] || return 0

  local agent_dir="$ARTIFACTS_DIR/$agent"
  mkdir -p "$agent_dir"

  # Copy log file
  if [[ -f "$log_file" ]]; then
    cp "$log_file" "$agent_dir/$(basename "$log_file")"
  fi

  # Copy agent-created files (e.g., openspec proposals for architect)
  if [[ "$agent" == "u-architect" ]]; then
    # Copy any new openspec changes
    local changes_dir="$REPO_ROOT/openspec/changes"
    if [[ -d "$changes_dir" ]]; then
      for d in "$changes_dir"/*/; do
        [[ -d "$d" ]] || continue
        # Only copy recently modified proposals (last 30 min)
        if find "$d" -maxdepth 0 -mmin -30 -print -quit 2>/dev/null | grep -q .; then
          cp -r "$d" "$agent_dir/" 2>/dev/null || true
        fi
      done
    fi
  elif [[ "$agent" == "u-summarizer" && -f "$TASK_SUMMARY_FILE" ]]; then
    cp "$TASK_SUMMARY_FILE" "$agent_dir/$(basename "$TASK_SUMMARY_FILE")" 2>/dev/null || true
  fi
}

get_resume_agent() {
  [[ -f "$CHECKPOINT_FILE" ]] || return
  
  local planned
  planned=$(jq -r '.planned_agents // ["planner","architect","coder","auditor","validator","tester","e2e","documenter","summarizer"] | .[]' "$CHECKPOINT_FILE" 2>/dev/null)
  
  local default_order="planner architect coder auditor validator tester e2e documenter summarizer"
  [[ -z "$planned" ]] && planned="$default_order"
  
  for agent in $planned; do
    local status
    status=$(jq -r --arg a "$agent" '.agents[$a].status // "pending"' "$CHECKPOINT_FILE" 2>/dev/null)
    if [[ "$status" != "done" ]]; then
      echo "$agent"
      return
    fi
  done
}

print_checkpoint_summary() {
  [[ -f "$CHECKPOINT_FILE" ]] || return
  
  local agents
  agents=$(jq -r '.agents | keys | .[]' "$CHECKPOINT_FILE" 2>/dev/null)
  [[ -z "$agents" ]] && { echo "  (no completed agents)"; return; }
  
  for name in $agents; do
    local status dur commit icon
    status=$(jq -r --arg n "$name" '.agents[$n].status // "?"' "$CHECKPOINT_FILE")
    dur=$(jq -r --arg n "$name" '.agents[$n].duration // 0' "$CHECKPOINT_FILE")
    commit=$(jq -r --arg n "$name" '.agents[$n].commit // ""' "$CHECKPOINT_FILE")
    [[ "$status" == "done" ]] && icon="✓" || icon="✗"
    echo "  $icon $name: $status (${dur}s) $commit"
  done
}

# ── Dev Reporter Agent integration ───────────────────────────────────

send_report_to_agent() {
  local status="$1"
  local failed_agent="${2:-}"
  local total_duration="$3"

  local core_url="${PLATFORM_CORE_URL:-http://localhost:80}"

  local failed_agent_json="null"
  if [[ -n "$failed_agent" ]]; then
    failed_agent_json="\"${failed_agent}\""
  fi

  local payload
  payload=$(printf '{"intent":"devreporter.ingest","agent":"dev-reporter-agent","payload":{"pipeline_id":"%s","task":"%s","branch":"%s","status":"%s","failed_agent":%s,"duration_seconds":%s,"agent_results":[]}}' \
    "${TIMESTAMP}" \
    "${TASK_MESSAGE//\"/\\\"}" \
    "${branch//\"/\\\"}" \
    "${status}" \
    "${failed_agent_json}" \
    "${total_duration}")

  local response
  response=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST "${core_url}/api/v1/a2a/send-message" \
    -H "Content-Type: application/json" \
    -d "$payload" \
    --max-time 10 2>/dev/null) || response="000"

  if [[ "$response" == "200" || "$response" == "201" ]]; then
    echo -e "  ${GREEN}✓ Pipeline report sent to dev-reporter-agent${NC}"
  else
    echo -e "  ${YELLOW}⚠ Could not reach dev-reporter-agent (HTTP ${response}) — continuing${NC}"
  fi
}

# ── Telegram notifications ────────────────────────────────────────────

send_telegram() {
  if [[ "$TELEGRAM_NOTIFY" != true ]]; then
    return 0
  fi

  if [[ -z "$TELEGRAM_BOT_TOKEN" || -z "$TELEGRAM_CHAT_ID" ]]; then
    echo -e "  ${YELLOW}⚠ Telegram: missing PIPELINE_TELEGRAM_BOT_TOKEN or PIPELINE_TELEGRAM_CHAT_ID${NC}"
    return 0
  fi

  local message="$1"
  curl -s -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
    -d chat_id="$TELEGRAM_CHAT_ID" \
    -d parse_mode="HTML" \
    -d text="$message" \
    -d disable_web_page_preview=true \
    &>/dev/null || echo -e "  ${YELLOW}⚠ Telegram notification failed${NC}"
}

# ── Run migrations if needed ──────────────────────────────────────────

run_migrations() {
  echo -e "  ${BLUE}Checking for new migrations...${NC}"

  local has_migrations=false

  # Check for PHP migrations (Doctrine)
  if git -C "$REPO_ROOT" diff --name-only HEAD~1 2>/dev/null | grep -qE 'migrations/Version'; then
    has_migrations=true

    # Determine which app has migrations
    if git -C "$REPO_ROOT" diff --name-only HEAD~1 | grep -q 'apps/brama-core/migrations'; then
      echo -e "  ${CYAN}Running core migrations...${NC}"
      (cd "$REPO_ROOT" && make migrate 2>&1) || echo -e "  ${YELLOW}⚠ Core migration warning${NC}"
    fi
    if git -C "$REPO_ROOT" diff --name-only HEAD~1 | grep -q 'apps/knowledge-agent/migrations'; then
      echo -e "  ${CYAN}Running knowledge-agent migrations...${NC}"
      (cd "$REPO_ROOT" && make knowledge-migrate 2>&1) || echo -e "  ${YELLOW}⚠ Knowledge migration warning${NC}"
    fi
    if git -C "$REPO_ROOT" diff --name-only HEAD~1 | grep -q 'apps/dev-reporter-agent/migrations'; then
      echo -e "  ${CYAN}Running dev-reporter-agent migrations...${NC}"
      (cd "$REPO_ROOT" && make dev-reporter-migrate 2>&1) || echo -e "  ${YELLOW}⚠ Dev-reporter migration warning${NC}"
    fi
  fi

  # Check for Python migrations (Alembic)
  if git -C "$REPO_ROOT" diff --name-only HEAD~1 2>/dev/null | grep -qE 'alembic/versions'; then
    has_migrations=true
    echo -e "  ${CYAN}Running news-maker migrations...${NC}"
    (cd "$REPO_ROOT" && make news-migrate 2>&1) || echo -e "  ${YELLOW}⚠ News-maker migration warning${NC}"
  fi

  if ! $has_migrations; then
    echo -e "  ${BLUE}No new migrations detected${NC}"
  fi
}

# ── Model fallback ────────────────────────────────────────────────────

get_fallback_chain() {
  local agent="$1"
  local base_name="${agent#u-}"
  base_name="${base_name#u_}"
  local var_name="FALLBACK_$(echo "$base_name" | tr '[:lower:]' '[:upper:]')"
  local chain="${!var_name:-}"
  [[ -n "$chain" ]] || return 0

  local expanded=()
  local token=""
  local free_tokens=()
  local cheap_tokens=()
  IFS=',' read -r -a raw_tokens <<< "$chain"
  for token in "${raw_tokens[@]}"; do
    token="${token#"${token%%[![:space:]]*}"}"
    token="${token%"${token##*[![:space:]]}"}"
    case "$token" in
      free)
        IFS=',' read -r -a free_tokens <<< "$FREE_MODELS"
        expanded+=("${free_tokens[@]}")
        ;;
      cheap)
        IFS=',' read -r -a cheap_tokens <<< "$CHEAP_MODELS"
        expanded+=("${cheap_tokens[@]}")
        ;;
      "")
        ;;
      *)
        expanded+=("$token")
        ;;
    esac
  done

  (IFS=','; echo "${expanded[*]}")
}

is_rate_limit_error() {
  local log_file="$1"
  grep -qiE 'rate.?limit|429|quota|too many requests|capacity|overloaded|insufficient.*balance|billing|payment.*required|credit.*expired|balance.*exceeded' "$log_file" 2>/dev/null
}

# Provider/model unavailable — credentials missing, model not found, auth failure
is_provider_error() {
  local log_file="$1"
  grep -qiE 'ProviderModelNotFoundError|Model not found|provider.*not.*found|credential|unauthorized|authentication.*fail|invalid.*api.?key|no.*provider' "$log_file" 2>/dev/null
}

# Empty prompt / missing message — pipeline bug, not a provider issue.
# Must NOT trigger fallback (would waste all fallback slots on a bad prompt).
is_empty_prompt_error() {
  local log_file="$1"
  grep -qiE 'You must provide a message|must provide.*command|message.*required|no.*message.*provided' "$log_file" 2>/dev/null
}

# Any error that should trigger a fallback to the next model.
# Empty-prompt errors are excluded — they indicate a pipeline bug, not a
# provider/rate-limit issue, and retrying with a different model won't help.
is_fallback_worthy_error() {
  local log_file="$1"
  # Never fallback on empty-prompt errors
  if is_empty_prompt_error "$log_file"; then
    return 1
  fi
  is_rate_limit_error "$log_file" || is_provider_error "$log_file"
}

get_current_model() {
  local agent="$1"
  local agent_file="$REPO_ROOT/.opencode/agents/${agent}.md"
  sed -n 's/^model:[[:space:]]*//p' "$agent_file" 2>/dev/null | tr -d ' '
}

# Model blacklist cache (30min TTL)
MODEL_BLACKLIST_FILE="${REPO_ROOT}/.opencode/pipeline/.model-blacklist.json"

is_model_blacklisted() {
  local model="$1"
  local now
  now=$(date +%s)

  [[ ! -f "$MODEL_BLACKLIST_FILE" ]] && return 1

  local blacklist_entry
  blacklist_entry=$(jq -r --arg model "$model" --argjson now "$now" \
    '.[$model] | select(. != null and . > $now)' \
    "$MODEL_BLACKLIST_FILE" 2>/dev/null || echo "")

  [[ -n "$blacklist_entry" ]]
}

blacklist_model() {
  local model="$1"
  local ttl_seconds="${2:-1800}"  # Default 30 min
  local now
  now=$(date +%s)
  local expires_at=$((now + ttl_seconds))

  mkdir -p "$(dirname "$MODEL_BLACKLIST_FILE")"

  if [[ -f "$MODEL_BLACKLIST_FILE" ]]; then
    jq --arg model "$model" --argjson expires "$expires_at" \
      '. + {($model): $expires}' \
      "$MODEL_BLACKLIST_FILE" > "${MODEL_BLACKLIST_FILE}.tmp" 2>/dev/null || echo "{}" > "${MODEL_BLACKLIST_FILE}.tmp"
  else
    echo "{\"$model\": $expires_at}" > "${MODEL_BLACKLIST_FILE}.tmp"
  fi

  mv "${MODEL_BLACKLIST_FILE}.tmp" "$MODEL_BLACKLIST_FILE"
  echo -e "${YELLOW}  🚫 Blacklisted model: ${model} for ${ttl_seconds}s${NC}"
}

filter_blacklisted_models() {
  local models_csv="$1"
  local filtered=()

  IFS=',' read -r -a model_array <<< "$models_csv"

  for model in "${model_array[@]}"; do
    if ! is_model_blacklisted "$model"; then
      filtered+=("$model")
    else
      echo -e "${YELLOW}  ⏭️  Skipping blacklisted model: ${model}${NC}" >&2
    fi
  done

  # Join array back to CSV
  local result
  result=$(IFS=','; echo "${filtered[*]}")
  echo "$result"
}

swap_agent_model() {
  local agent="$1"
  local new_model="$2"
  local agent_file="$REPO_ROOT/.opencode/agents/${agent}.md"

  if [[ ! -f "$agent_file" ]]; then
    return 1
  fi

  local old_model
  old_model=$(get_current_model "$agent")

  debug_log "model" "MODEL SWAP" "agent=$agent" "from=$old_model" "to=$new_model" "file=$agent_file"
  sed -i.bak "s|^model:.*|model: ${new_model}|" "$agent_file"
  rm -f "${agent_file}.bak"

  echo -e "  ${YELLOW}⚡ Model swap: ${old_model} → ${new_model}${NC}"
  send_telegram "⚡ <b>${agent}</b> model swap
<code>${old_model}</code> → <code>${new_model}</code>
📋 <i>Rate limit hit, using fallback</i>"
}

restore_agent_model() {
  local agent="$1"
  local original_model="$2"
  local agent_file="$REPO_ROOT/.opencode/agents/${agent}.md"

  if [[ -n "$original_model" && -f "$agent_file" ]]; then
    sed -i.bak "s|^model:.*|model: ${original_model}|" "$agent_file"
    rm -f "${agent_file}.bak"
  fi
}

# ── Token tracking via opencode session export ───────────────────────

# Get the most recent opencode session ID for the current working directory
get_latest_session_id() {
  local session_json
  session_json=$(cd "$REPO_ROOT" && opencode session list --format json -n 1 2>/dev/null) || session_json=""

  if [[ -z "$session_json" ]]; then
    echo ""
    return
  fi

  echo "$session_json" | jq -r '.[0].id // empty' 2>/dev/null || echo ""
}

# Query token usage from an opencode session export
# Replaces the old LiteLLM-based query_agent_tokens()
query_session_tokens() {
  local session_id="$1"
  local fallback='{"input_tokens":0,"output_tokens":0,"cache_read":0,"cache_write":0,"cost":0}'

  if [[ -z "$session_id" ]]; then
    echo "$fallback"
    return
  fi

  local tmp_file="/tmp/pipeline_session_${$}_${RANDOM}.json"

  if ! export_session_json "$session_id" "$tmp_file"; then
    rm -f "$tmp_file"
    echo "$fallback"
    return
  fi

  local result
  result=$(summarize_export_tokens "$tmp_file" 2>/dev/null) || result=""

  rm -f "$tmp_file"

  if [[ -z "$result" ]]; then
    echo "$fallback"
    return
  fi

  local input_tokens output_tokens cache_read
  input_tokens=$(echo "$result" | jq -r '.input_tokens // 0' 2>/dev/null || echo 0)
  output_tokens=$(echo "$result" | jq -r '.output_tokens // 0' 2>/dev/null || echo 0)
  cache_read=$(echo "$result" | jq -r '.cache_read // 0' 2>/dev/null || echo 0)
  local model="unknown"
  local cost="0"
  cost=$(calculate_cost_from_values "$model" "$input_tokens" "$output_tokens" "$cache_read" 2>/dev/null || echo 0)

  echo "$result" | jq --argjson cost "$cost" '. + {cost: $cost}' 2>/dev/null || echo "$fallback"
}

# Detect worker ID from worktree path (e.g. .pipeline-worktrees/worker-2 → worker-2)
_detect_worker_id() {
  local cwd; cwd=$(pwd)
  if [[ "$cwd" =~ \.pipeline-worktrees/(worker-[0-9]+) ]]; then
    echo "${BASH_REMATCH[1]}"
  elif [[ "$cwd" =~ \.pipeline-worktrees/(adhoc-[0-9]+) ]]; then
    echo "${BASH_REMATCH[1]}"
  fi
}

# Write per-agent metadata sidecar file
write_agent_meta() {
  local agent="$1"
  local model="$2"
  local started_epoch="$3"
  local finished_epoch="$4"
  local exit_code="$5"
  local log_file="$6"
  local tokens_json="${7:-{}}"
  local step_cost="${8:-0}"
  local session_id="${9:-}"

  local meta_file="$LOG_DIR/${TIMESTAMP}_${agent}.meta.json"
  local log_bytes=0
  local log_lines=0

  if [[ -f "$log_file" ]]; then
    log_bytes=$(wc -c < "$log_file" | tr -d ' ')
    log_lines=$(wc -l < "$log_file" | tr -d ' ')
  fi

  local duration=$(( finished_epoch - started_epoch ))

  # Task and worker context for Activity Log
  local task_slug="${TASK_SLUG:-}"
  local worker_id; worker_id=$(_detect_worker_id)

  cat > "$meta_file" << META_EOF
{
  "workflow": "builder",
  "agent": "$agent",
  "model": "$model",
  "task": "$task_slug",
  "worker": "${worker_id:-main}",
  "started_epoch": $started_epoch,
  "finished_epoch": $finished_epoch,
  "duration_seconds": $duration,
  "exit_code": $exit_code,
  "log_file": "$(basename "$log_file")",
  "log_bytes": $log_bytes,
  "log_lines": $log_lines,
  "session_id": "$session_id",
  "cost": $step_cost,
  "tokens": $tokens_json
}
META_EOF
}

# ── Pipeline cost tracking ──────────────────────────────────────────

CUMULATIVE_COST=0

check_cost_budget() {
  if [[ -z "$PIPELINE_MAX_COST" ]]; then
    return 0  # no budget set
  fi

  local over
  over=$(echo "$CUMULATIVE_COST $PIPELINE_MAX_COST" | awk '{if ($1 > $2) print "yes"; else print "no"}')

  if [[ "$over" == "yes" ]]; then
    echo -e "${RED}✗ Pipeline cost budget exceeded: \$${CUMULATIVE_COST} > \$${PIPELINE_MAX_COST}${NC}"
    send_telegram "🛑 <b>Pipeline BUDGET EXCEEDED</b>
💰 Spent: \$${CUMULATIVE_COST} / \$${PIPELINE_MAX_COST}
📋 <i>${TASK_MESSAGE}</i>"
    return 1
  fi
  return 0
}

# ── Profile system ──────────────────────────────────────────────────

PROFILES_FILE="$PIPELINE_DIR/profiles.json"

apply_profile() {
  local profile_name="$1"

  if [[ ! -f "$PROFILES_FILE" ]]; then
    echo -e "${YELLOW}⚠ Profiles file not found: ${PROFILES_FILE}${NC}"
    return 1
  fi

  if ! jq -e ".\"${profile_name}\"" "$PROFILES_FILE" &>/dev/null; then
    echo -e "${YELLOW}⚠ Unknown profile: ${profile_name}${NC}"
    return 1
  fi

  echo -e "${CYAN}Applying profile: ${profile_name}${NC}"

  # Override AGENTS array
  local agents_json
  agents_json=$(jq -r ".\"${profile_name}\".agents[]" "$PROFILES_FILE" 2>/dev/null)
  if [[ -n "$agents_json" ]]; then
    AGENTS=()
    while IFS= read -r agent; do
      AGENTS+=("$agent")
    done <<< "$agents_json"
    echo -e "  ${BLUE}Agents: ${AGENTS[*]}${NC}"
  fi

  # Override timeouts
  local timeouts
  timeouts=$(jq -r ".\"${profile_name}\".timeout_overrides // {} | to_entries[] | \"\(.key)=\(.value)\"" "$PROFILES_FILE" 2>/dev/null)
  while IFS='=' read -r key val; do
    [[ -z "$key" ]] && continue
    local var="PIPELINE_TIMEOUT_$(echo "$key" | tr '[:lower:]' '[:upper:]')"
    eval "$var=$val"
    echo -e "  ${BLUE}Timeout ${key}: ${val}s${NC}"
  done <<< "$timeouts"
}

# ── Planner agent integration ──────────────────────────────────────

PLAN_FILE="$REPO_ROOT/pipeline-plan.json"
PIPELINE_TIMEOUT_PLANNER="${PIPELINE_TIMEOUT_PLANNER:-300}"  # 5 min
FALLBACK_PLANNER="${PIPELINE_FALLBACK_PLANNER:-google/gemini-2.5-flash,free,cheap}"

apply_plan() {
  local plan_file="$1"

  if [[ ! -f "$plan_file" ]]; then
    echo -e "${YELLOW}⚠ Plan file not found, using standard profile${NC}"
    return 1
  fi

  if ! jq -e '.' "$plan_file" &>/dev/null; then
    echo -e "${YELLOW}⚠ Invalid plan JSON, using standard profile${NC}"
    return 1
  fi

  local profile
  profile=$(jq -r '.profile // "standard"' "$plan_file")
  local reasoning
  reasoning=$(jq -r '.reasoning // ""' "$plan_file")

  echo -e "${CYAN}Planner chose profile: ${profile}${NC}"
  emit_event "PLAN" "profile=${profile}|agents=$(jq -r '.agents // [] | join(" → ")' "$plan_file" 2>/dev/null)"
  if [[ -n "$reasoning" ]]; then
    echo -e "  ${BLUE}Reasoning: ${reasoning}${NC}"
  fi

  # Apply profile from profiles.json
  PIPELINE_PROFILE="$profile"
  apply_profile "$profile" || true

  # Override agents if planner specified a custom list
  local custom_agents
  custom_agents=$(jq -r '.agents // [] | .[]' "$plan_file" 2>/dev/null)
  if [[ -n "$custom_agents" ]]; then
    AGENTS=()
    while IFS= read -r agent; do
      AGENTS+=("$agent")
    done <<< "$custom_agents"
    echo -e "  ${BLUE}Custom agents: ${AGENTS[*]}${NC}"
  fi

  # Apply timeout overrides from plan
  local timeouts
  timeouts=$(jq -r '.timeout_overrides // {} | to_entries[] | "\(.key)=\(.value)"' "$plan_file" 2>/dev/null)
  while IFS='=' read -r key val; do
    [[ -z "$key" ]] && continue
    local var="PIPELINE_TIMEOUT_$(echo "$key" | tr '[:lower:]' '[:upper:]')"
    eval "$var=$val"
  done <<< "$timeouts"

  # Apply model overrides from plan
  local model_overrides
  model_overrides=$(jq -r '.model_overrides // {} | to_entries[] | "\(.key)=\(.value)"' "$plan_file" 2>/dev/null)
  while IFS='=' read -r key val; do
    [[ -z "$key" ]] && continue
    swap_agent_model "$key" "$val" 2>/dev/null || true
  done <<< "$model_overrides"

  # Auto-inject auditor for agent-related tasks
  if [[ "$ENABLE_AUDIT" != true ]]; then
    auto_inject_auditor "$plan_file"
  fi
}

# ── Auto-audit detection for agent tasks ─────────────────────────────

auto_inject_auditor() {
  local plan_file="$1"

  # Trust planner's decision — it uses Opus and analyzes the task in detail
  local is_agent_task="false"
  if [[ -f "$plan_file" ]]; then
    is_agent_task=$(jq -r '.is_agent_task // false' "$plan_file" 2>/dev/null || echo "false")
  fi

  # Fallback only when plan.json is missing: check for brama platform agent work
  # NOTE: .opencode/agents/ changes (pipeline configs) do NOT count as agent tasks
  if [[ "$is_agent_task" != "true" && ! -f "$plan_file" ]]; then
    local task_lower
    task_lower=$(echo "$TASK_MESSAGE" | tr '[:upper:]' '[:lower:]')
    if echo "$task_lower" | grep -qE '(new agent|create agent|add .+-agent)' && \
       echo "$task_lower" | grep -qvE '(foundry|pipeline|opencode.agents)'; then
      is_agent_task="true"
    fi
  fi

  if [[ "$is_agent_task" == "true" ]]; then
    # Check if auditor is already in the list
    local has_auditor=false
    for a in "${AGENTS[@]}"; do
      [[ "$a" == "u-auditor" ]] && has_auditor=true
    done

    if [[ "$has_auditor" == false ]]; then
      # Insert auditor right after coder
      local new_agents=()
      for a in "${AGENTS[@]}"; do
        new_agents+=("$a")
        if [[ "$a" == "u-coder" ]]; then
          new_agents+=("u-auditor")
        fi
      done
      AGENTS=("${new_agents[@]}")
      ENABLE_AUDIT=true
      echo -e "${CYAN}🔍 Agent task detected — u-auditor auto-injected after u-coder${NC}"
      echo -e "  ${BLUE}Agents: ${AGENTS[*]}${NC}"
    fi
  fi
}

# ── Anti-loop monitor ────────────────────────────────────────────────

# Kill process and all its descendants recursively.
# Needed because agent runs as: tee ← subshell ← script ← timeout ← opencode
# A simple kill only hits tee, leaving opencode as orphan.
_kill_process_tree() {
  local pid="$1"
  local children
  children=$(pgrep -P "$pid" 2>/dev/null || true)
  for child in $children; do
    _kill_process_tree "$child"
  done
  kill "$pid" 2>/dev/null || true
}

monitor_agent_loop() {
  local log_file="$1"
  local agent="$2"
  local agent_pid="$3"
  local check_interval=60
  # Agents that run long shell commands (docker build, make test) need more
  # stall tolerance — their log won't grow while the subprocess runs.
  local max_stalls=3
  case "$agent" in
    u-coder|u-tester|e2e) max_stalls=8 ;;   # 8 min
    u-validator)          max_stalls=5 ;;    # 5 min
  esac
  local prev_size=0
  local stall_count=0

  local monitor_start
  monitor_start=$(date +%s)
  local fast_check_count=0

  while kill -0 "$agent_pid" 2>/dev/null; do
    # Use faster checks (20s) for the first few iterations to catch stalled models.
    # Measured TTFO: all working models respond within 8s; 20s gives safe margin for slow free-tier.
    local current_interval=$check_interval
    if [[ $fast_check_count -lt 2 ]]; then
      current_interval=20
      fast_check_count=$((fast_check_count + 1))
    fi

    sleep "$current_interval"
    [[ -f "$log_file" ]] || continue

    local cur_size
    cur_size=$(wc -c < "$log_file" 2>/dev/null | tr -d ' ' || echo 0)

    # Check 1: Log file not growing (agent stalled)
    if [[ "$cur_size" -eq "$prev_size" && "$cur_size" -gt 0 ]]; then
      stall_count=$((stall_count + 1))

      # Faster stall detection if log is minimal (model didn't start)
      local stall_threshold=$max_stalls
      local log_lines
      log_lines=$(wc -l < "$log_file" 2>/dev/null | tr -d ' ' || echo 0)

      # If log has < 5 lines, use aggressive stall detection
      # This handles cases where model fails to start due to rate limits
      if [[ "$log_lines" -lt 5 && "$stall_count" -ge 1 ]]; then
        # After just 20s with minimal output, trigger fallback
        local stall_duration=$((20 + (stall_count - 1) * current_interval))
        debug_log "stall" "STALL DETECTED (minimal output)" "agent=$agent" "duration=${stall_duration}s" "lines=$log_lines" "pid=$agent_pid"
        echo "LOOP_DETECTED:stall:Log not growing for ${stall_duration}s (minimal output: ${log_lines} lines)" > "${log_file}.loop"
        debug_log "kill" "Killing stalled agent tree" "pid=$agent_pid"
        _kill_process_tree "$agent_pid"
        debug_log "kill" "Kill complete" "pid=$agent_pid"
        return
      fi

      # Normal stall detection for active logs
      if [[ $stall_count -ge $stall_threshold ]]; then
        local stall_duration=$((40 + (stall_count - 2) * check_interval))  # 2 * 20s + rest * 60s
        debug_log "stall" "STALL DETECTED (normal)" "agent=$agent" "duration=${stall_duration}s" "stall_count=$stall_count" "threshold=$stall_threshold"
        echo "LOOP_DETECTED:stall:Log not growing for ${stall_duration}s" > "${log_file}.loop"
        debug_log "kill" "Killing stalled agent tree" "pid=$agent_pid"
        _kill_process_tree "$agent_pid"
        debug_log "kill" "Kill complete" "pid=$agent_pid"
        return
      fi
    else
      stall_count=0
    fi

    # Check 2: Repeated error patterns in recent output
    if [[ "$cur_size" -gt 1000 ]]; then
      local recent_errors
      recent_errors=$(tail -100 "$log_file" 2>/dev/null | grep -iE 'error|failed|exception' 2>/dev/null | wc -l | tr -d ' ')
      if [[ "$recent_errors" -gt 30 ]]; then
        local unique_errors
        unique_errors=$(tail -100 "$log_file" 2>/dev/null | grep -iE 'error|failed|exception' | sort -u | wc -l | tr -d ' ')
        if [[ "$unique_errors" -lt 3 ]]; then
          echo "LOOP_DETECTED:repeated_errors:${recent_errors} errors with only ${unique_errors} unique patterns" > "${log_file}.loop"
          _kill_process_tree "$agent_pid"
          return
        fi
      fi
    fi

    # Check 3: Iteration counting for validator/tester
    # Detects repeated make cycles (cs-fix/analyse/test) that aren't making progress
    if [[ "$agent" == "u-validator" || "$agent" == "u-tester" ]]; then
      local make_runs
      make_runs=$(grep -cE 'make (cs-fix|cs-check|analyse|test|knowledge-|hello-|news-)' "$log_file" 2>/dev/null || true)
      local max_iterations=8  # ~4 cycles of fix+check
      if [[ "$make_runs" -gt "$max_iterations" ]]; then
        # Check if errors are decreasing — if not, it's a loop
        local recent_errors prev_errors
        recent_errors=$(tail -50 "$log_file" 2>/dev/null | grep -iE 'error|ERROR' 2>/dev/null | wc -l | tr -d ' ')
        prev_errors=$(sed -n '1,50p' "$log_file" 2>/dev/null | grep -iE 'error|ERROR' 2>/dev/null | wc -l | tr -d ' ')
        if [[ "$recent_errors" -ge "$prev_errors" && "$recent_errors" -gt 0 ]]; then
          echo "LOOP_DETECTED:iteration_limit:${make_runs} make runs, errors not decreasing (${prev_errors}->${recent_errors})" > "${log_file}.loop"
          _kill_process_tree "$agent_pid"
          return
        fi
      fi
    fi

    prev_size=$cur_size
  done
}

# ── Verify coder produced real code changes ──────────────────────────
#
# After the coder stage, check that actual source files were modified
# (not just handoff.md or pipeline metadata). If coder produced nothing,
# it likely hit a permission error (e.g. worktree external_directory rejection)
# and downstream stages would run on unchanged code — a silent no-op.

verify_coder_output() {
  echo -e "  ${BLUE}Verifying coder produced code changes...${NC}"

  # Get list of changed files (staged + unstaged + untracked), excluding pipeline metadata
  local changed_files
  changed_files=$(git -C "$REPO_ROOT" diff --name-only HEAD~1 2>/dev/null || echo "")

  # Also check uncommitted changes
  local uncommitted
  uncommitted=$(git -C "$REPO_ROOT" diff --name-only 2>/dev/null || echo "")
  local untracked
  untracked=$(git -C "$REPO_ROOT" ls-files --others --exclude-standard 2>/dev/null || echo "")

  local all_changes
  all_changes=$(printf '%s\n%s\n%s' "$changed_files" "$uncommitted" "$untracked" | sort -u)

  # Filter out pipeline metadata — only count real source files
  local real_changes
  real_changes=$(echo "$all_changes" | grep -vE '^\.opencode/|^\.pipeline-task|^handoff\.md$|^$' || true)

  if [[ -z "$real_changes" ]]; then
    echo -e "  ${RED}✗ Coder produced NO source file changes${NC}"
    echo -e "  ${YELLOW}  Only pipeline metadata was modified. The coder agent likely failed silently.${NC}"
    return 1
  fi

  local file_count
  file_count=$(echo "$real_changes" | wc -l | tr -d ' ')
  echo -e "  ${GREEN}✓ Coder modified ${file_count} source file(s)${NC}"
  return 0
}

# ── Run a single agent with timeout and retry ─────────────────────────

run_agent() {
  local agent="$1"
  local message="$2"
  local log_file="$LOG_DIR/${TIMESTAMP}_${agent}.log"
  local agent_timeout
  agent_timeout=$(get_timeout "$agent")
  local timeout_min=$(( agent_timeout / 60 ))

  # Save original model for restoration
  local original_model
  original_model=$(get_current_model "$agent")

  # Build list of models to try: primary + fallbacks
  local fallback_chain
  fallback_chain=$(get_fallback_chain "$agent")
  local models_to_try="$original_model"
  if [[ -n "$fallback_chain" ]]; then
    models_to_try="${original_model},${fallback_chain}"
  fi

  emit_event "AGENT_START" "agent=${agent}|model=${original_model}|fallbacks=${fallback_chain:-none}"
  debug_log "agent" "AGENT_START" "agent=$agent" "model=$original_model" "fallback=$fallback_chain" "timeout=${agent_timeout}s" "log=$log_file"

  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo -e "${BLUE}▶ Agent:   ${YELLOW}${agent}${NC}"
  echo -e "${BLUE}▶ Model:   ${NC}${original_model}"
  echo -e "${BLUE}▶ Fallback:${NC} ${fallback_chain:-none}"
  echo -e "${BLUE}▶ Started: ${NC}$(date '+%H:%M:%S')"
  echo -e "${BLUE}▶ Timeout: ${NC}${timeout_min} min"
  echo -e "${BLUE}▶ Log:     ${NC}${log_file}"
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  echo ""

  local attempt=0
  local max_attempts=$(( MAX_RETRIES + 1 ))
  local fallback_index=0

  # Split fallback chain into array, filtering blacklisted models
  local filtered_fallback_chain
  filtered_fallback_chain=$(filter_blacklisted_models "$fallback_chain")
  IFS=',' read -r -a fallback_models <<< "$filtered_fallback_chain"

  while [[ $attempt -lt $max_attempts ]]; do
    attempt=$((attempt + 1))

    if [[ $attempt -gt 1 ]]; then
      echo -e "${YELLOW}  Retry ${attempt}/${max_attempts} after ${RETRY_DELAY}s...${NC}"
      sleep "$RETRY_DELAY"
    fi

    # Run with timeout, tracking PID for loop monitor
    # NOTE: We cd into REPO_ROOT instead of using --dir because opencode
    # registers git worktrees as "sandboxes" with restricted permissions
    # when passed via --dir. Running from CWD lets opencode detect the
    # worktree as an independent project with full file access.
    local exit_code=0
    local agent_start_epoch
    agent_start_epoch=$(date +%s)

    # Use 'script' to allocate a pseudo-TTY so opencode streams output
    # line-by-line instead of block-buffering (Node.js buffers stdout in pipes)
    local current_model
    current_model=$(get_current_model "$agent")
    local run_cmd="opencode run --agent ${agent} $(printf '%q' "$message")"
    if command -v timeout &>/dev/null; then
      run_cmd="timeout ${agent_timeout} ${run_cmd}"
    fi
    debug_log "process" "Spawning agent process" "agent=$agent" "model=$current_model" "attempt=$attempt/$max_attempts" "pid=pending" "timeout=${agent_timeout}s"
    if command -v script &>/dev/null; then
      (cd "$REPO_ROOT" && script -qc "$run_cmd" /dev/null) \
        < /dev/null 2>&1 | tee "$log_file" &
    else
      (cd "$REPO_ROOT" && eval "$run_cmd") \
        < /dev/null 2>&1 | tee "$log_file" &
    fi
    local agent_pid=$!
    debug_log "process" "Agent process spawned" "agent=$agent" "tee_pid=$agent_pid"

    # Start loop monitor in background
    monitor_agent_loop "$log_file" "$agent" "$agent_pid" &
    local monitor_pid=$!
    debug_log "process" "Loop monitor started" "agent=$agent" "monitor_pid=$monitor_pid" "agent_pid=$agent_pid"

    # Wait for agent to finish
    wait "$agent_pid" 2>/dev/null || exit_code=$?
    debug_log "process" "Agent process exited" "agent=$agent" "exit_code=$exit_code" "pid=$agent_pid"

    # Kill monitor
    kill "$monitor_pid" 2>/dev/null
    wait "$monitor_pid" 2>/dev/null

    local agent_end_epoch
    agent_end_epoch=$(date +%s)

    # Capture session ID for token tracking
    local session_id
    session_id=$(get_latest_session_id)

    # Check if loop was detected
    if [[ -f "${log_file}.loop" ]]; then
      local loop_info
      loop_info=$(cat "${log_file}.loop")
      rm -f "${log_file}.loop"
      echo -e "${RED}✗ Loop detected for '${agent}': ${loop_info}${NC}"

      # Query tokens from opencode session export
      local export_file="/tmp/pipeline_export_${agent}_${$}_${RANDOM}.json"
      local tokens_json
      local tools_json='[]'
      local files_json='[]'
      local context_json='{}'
      local actual_model_used
      actual_model_used="$(get_current_model "$agent")"
      if [[ -n "$session_id" ]] && export_session_json "$session_id" "$export_file"; then
        tokens_json=$(summarize_export_tokens "$export_file")
        tools_json=$(extract_session_tools "$export_file")
        files_json=$(extract_session_files_read "$export_file")
        context_json=$(extract_session_context "$export_file")
      else
        tokens_json='{"input_tokens":0,"output_tokens":0,"cache_read":0,"cache_write":0}'
      fi
      local in_tok out_tok cache_r step_cost
      in_tok=$(echo "$tokens_json" | jq -r '.input_tokens // 0' 2>/dev/null || echo 0)
      out_tok=$(echo "$tokens_json" | jq -r '.output_tokens // 0' 2>/dev/null || echo 0)
      cache_r=$(echo "$tokens_json" | jq -r '.cache_read // 0' 2>/dev/null || echo 0)
      step_cost=$(calculate_cost_from_values "$actual_model_used" "$in_tok" "$out_tok" "$cache_r")
      tokens_json=$(echo "$tokens_json" | jq --argjson cost "$step_cost" '. + {cost: $cost}' 2>/dev/null || echo "$tokens_json")
      write_agent_meta "$agent" "$actual_model_used" "$agent_start_epoch" "$agent_end_epoch" "2" "$log_file" "$tokens_json" "$step_cost" "$session_id"
      write_telemetry_record "$TELEMETRY_DIR/${agent}.json" "builder" "$agent" "$actual_model_used" "$(( agent_end_epoch - agent_start_epoch ))" "2" "$session_id" "$tokens_json" "$tools_json" "$files_json" "$step_cost" "$context_json"
      if [[ -f "$export_file" ]]; then
        cp "$export_file" "$ARTIFACTS_DIR/$agent.session.json" 2>/dev/null || true
        cp "$export_file" "$LOG_DIR/${TIMESTAMP}_${agent}.session.json" 2>/dev/null || true
        rm -f "$export_file"
      fi

      # Store token results for report
      set_agent_tokens "$agent" "$tokens_json"

      local agent_cost
      agent_cost=$(echo "$tokens_json" | jq -r '.cost' 2>/dev/null || echo 0)
      CUMULATIVE_COST=$(echo "$CUMULATIVE_COST $agent_cost" | awk '{printf "%.4f", $1 + $2}')

      send_telegram "🔄 <b>${agent}</b> LOOP DETECTED
📋 <i>${loop_info}</i>
💰 Cost so far: \$${CUMULATIVE_COST}"

      # Stall/loop should trigger fallback (model may be unresponsive due to rate limit)
      if [[ $fallback_index -lt ${#fallback_models[@]} ]]; then
        local failed_model
        failed_model=$(get_current_model "$agent")

        # Blacklist the failed model (30min TTL)
        blacklist_model "$failed_model" 1800

        local next_model="${fallback_models[$fallback_index]}"
        fallback_index=$((fallback_index + 1))

        # Skip blacklisted models in fallback chain
        while [[ $fallback_index -le ${#fallback_models[@]} ]] && is_model_blacklisted "$next_model"; do
          echo -e "${YELLOW}  ⏭️  Skipping blacklisted fallback model: ${next_model}${NC}"
          if [[ $fallback_index -lt ${#fallback_models[@]} ]]; then
            next_model="${fallback_models[$fallback_index]}"
            fallback_index=$((fallback_index + 1))
          else
            next_model=""
            break
          fi
        done

        if [[ -z "$next_model" ]]; then
          echo -e "${RED}✗ No more fallback models available (all blacklisted)${NC}"
          restore_agent_model "$agent" "$original_model"
          return 1
        fi

        echo -e "${YELLOW}  Stall detected — switching to fallback: ${next_model}${NC}"
        emit_event "AGENT_FALLBACK" "agent=${agent}|from=${failed_model}|to=${next_model}|reason=stall"
        swap_agent_model "$agent" "$next_model"
        attempt=$((attempt - 1))
        sleep 5
        continue
      fi

      restore_agent_model "$agent" "$original_model"
      return 1
    fi

    # Query token usage from opencode session export
    local export_file="/tmp/pipeline_export_${agent}_${$}_${RANDOM}.json"
    local tokens_json
    local tools_json='[]'
    local files_json='[]'
    local context_json='{}'
    local actual_model_used
    actual_model_used=$(get_current_model "$agent")
    if [[ -n "$session_id" ]] && export_session_json "$session_id" "$export_file"; then
      tokens_json=$(summarize_export_tokens "$export_file")
      tools_json=$(extract_session_tools "$export_file")
      files_json=$(extract_session_files_read "$export_file")
      context_json=$(extract_session_context "$export_file")
      local detected_model
      detected_model=$(extract_export_model "$export_file" 2>/dev/null || echo "")
      [[ -n "$detected_model" && "$detected_model" != "unknown" ]] && actual_model_used="$detected_model"
    else
      tokens_json='{"input_tokens":0,"output_tokens":0,"cache_read":0,"cache_write":0}'
    fi
    local in_tok out_tok cache_r cache_w
    in_tok=$(echo "$tokens_json" | jq -r '.input_tokens // 0' 2>/dev/null || echo 0)
    out_tok=$(echo "$tokens_json" | jq -r '.output_tokens // 0' 2>/dev/null || echo 0)
    cache_r=$(echo "$tokens_json" | jq -r '.cache_read // 0' 2>/dev/null || echo 0)
    cache_w=$(echo "$tokens_json" | jq -r '.cache_write // 0' 2>/dev/null || echo 0)
    local step_cost
    step_cost=$(calculate_cost_from_values "$actual_model_used" "$in_tok" "$out_tok" "$cache_r")
    tokens_json=$(echo "$tokens_json" | jq --argjson cost "$step_cost" '. + {cost: $cost}' 2>/dev/null || echo "$tokens_json")
    write_agent_meta "$agent" "$actual_model_used" "$agent_start_epoch" "$agent_end_epoch" "$exit_code" "$log_file" "$tokens_json" "$step_cost" "$session_id"
    write_telemetry_record "$TELEMETRY_DIR/${agent}.json" "builder" "$agent" "$actual_model_used" "$(( agent_end_epoch - agent_start_epoch ))" "$exit_code" "$session_id" "$tokens_json" "$tools_json" "$files_json" "$step_cost" "$context_json"
    if [[ -f "$export_file" ]]; then
      cp "$export_file" "$ARTIFACTS_DIR/$agent.session.json" 2>/dev/null || true
      cp "$export_file" "$LOG_DIR/${TIMESTAMP}_${agent}.session.json" 2>/dev/null || true
      rm -f "$export_file"
    fi

    # Store token results for report
    set_agent_tokens "$agent" "$tokens_json"

    local agent_cost
    agent_cost=$(echo "$tokens_json" | jq -r '.cost' 2>/dev/null || echo 0)
    CUMULATIVE_COST=$(echo "$CUMULATIVE_COST $agent_cost" | awk '{printf "%.4f", $1 + $2}')
    emit_event "COST" "agent=${agent}|model=${actual_model_used}|input=${in_tok}|output=${out_tok}|price=${agent_cost}|time=$(( agent_end_epoch - agent_start_epoch ))s"

    # Update state.json with agent telemetry
    local agent_status_for_state="done"
    [[ $exit_code -ne 0 ]] && agent_status_for_state="failed"
    foundry_state_upsert_agent "$TASK_DIR" "$agent" "$agent_status_for_state" "$actual_model_used" \
      "$(( agent_end_epoch - agent_start_epoch ))" "$in_tok" "$out_tok" "$agent_cost" "1" "$session_id"

    # Check result
    if [[ $exit_code -eq 0 ]]; then
      local agent_dur=$(( agent_end_epoch - agent_start_epoch ))
      emit_event "AGENT_DONE" "agent=${agent}|model=${actual_model_used}|status=ok|duration=${agent_dur}s|tokens=${in_tok}/${out_tok}|cache=${cache_r}"

      echo ""
      echo -e "${GREEN}✓ Agent '${agent}' completed successfully${NC}"
      if [[ "$actual_model_used" != "$original_model" ]]; then
        echo -e "  ${YELLOW}Model: ${actual_model_used} (fallback from ${original_model})${NC}"
      fi
      echo -e "  ${BLUE}Tokens: ${in_tok} in / ${out_tok} out | Cache: ${cache_r} read / ${cache_w} write${NC}"
      restore_agent_model "$agent" "$original_model"

      # Check cost budget
      if ! check_cost_budget; then
        return 1
      fi
      return 0
    elif [[ $exit_code -eq 75 ]]; then
      # HITL: Agent is waiting for human answers
      local agent_dur=$(( agent_end_epoch - agent_start_epoch ))
      emit_event "AGENT_DONE" "agent=${agent}|status=waiting_answer|duration=${agent_dur}s"

      echo ""
      echo -e "${YELLOW}⏸ Agent '${agent}' is waiting for answers (exit 75)${NC}"
      restore_agent_model "$agent" "$original_model"

      # Update agent status in state.json
      if [[ "$TASK_LIFECYCLE" == true && -n "$TASK_DIR" ]]; then
        foundry_state_upsert_agent "$TASK_DIR" "$agent" "waiting_answer" "$actual_model_used" \
          "$agent_dur" "$in_tok" "$out_tok" "$agent_cost" "1" "$session_id"
      fi

      # Handle waiting_answer: validate qa.json, update state, check continue_on_wait
      local hitl_result=0
      if [[ -n "$TASK_DIR" ]]; then
        foundry_handle_waiting_answer "$agent" "$TASK_DIR" || hitl_result=$?
      else
        echo -e "${YELLOW}  No TASK_DIR — cannot handle waiting_answer properly${NC}"
        hitl_result=75
      fi

      # Send Telegram notification (if configured)
      if [[ -f "$REPO_ROOT/agentic-development/lib/foundry-telegram.sh" ]]; then
        # shellcheck source=/dev/null
        source "$REPO_ROOT/agentic-development/lib/foundry-telegram.sh"
        local qa_count
        qa_count=$(foundry_state_field "$TASK_DIR" "questions_count" 2>/dev/null || echo "?")
        local task_slug_short="${TASK_SLUG:-task}"
        send_telegram_hitl_waiting "$agent" "$task_slug_short" "$qa_count"
      fi

      if [[ $hitl_result -eq 0 ]]; then
        # continue_on_wait=true — pipeline continues
        echo -e "${CYAN}  continue_on_wait=true — proceeding to next agent${NC}"
        return 75  # Special return: caller handles this
      else
        # Pipeline paused
        echo -e "${YELLOW}  Pipeline paused — use: foundry.sh answer ${TASK_SLUG:-<slug>}${NC}"
        echo -e "${YELLOW}  Then resume with: foundry.sh resume-qa ${TASK_SLUG:-<slug>}${NC}"
        return 75
      fi
    elif [[ $exit_code -eq 124 ]]; then
      emit_event "AGENT_DONE" "agent=${agent}|status=timeout|duration=${timeout_min}m"
      echo -e "${RED}✗ Agent '${agent}' timed out after ${timeout_min} min${NC}"
      restore_agent_model "$agent" "$original_model"
      return 1
    else
      emit_event "AGENT_DONE" "agent=${agent}|status=fail|exit=${exit_code}"
      echo -e "${RED}✗ Agent '${agent}' failed (exit code: ${exit_code})${NC}"

      # Check if it's a rate limit or provider error — try fallback model
      if is_fallback_worthy_error "$log_file" && [[ $fallback_index -lt ${#fallback_models[@]} ]]; then
        local next_model="${fallback_models[$fallback_index]}"
        fallback_index=$((fallback_index + 1))
        local err_type="Rate limit"
        is_provider_error "$log_file" && err_type="Provider/model unavailable"
        echo -e "${YELLOW}  ${err_type} detected — switching to fallback: ${next_model}${NC}"
        emit_event "AGENT_FALLBACK" "agent=${agent}|from=$(get_current_model "$agent")|to=${next_model}"
        swap_agent_model "$agent" "$next_model"
        # Don't count fallback as a retry — reset attempt counter
        attempt=$((attempt - 1))
        sleep 5
      elif [[ $attempt -lt $max_attempts ]]; then
        echo -e "${YELLOW}  Will retry...${NC}"
      fi
    fi
  done

  # Restore original model before returning
  restore_agent_model "$agent" "$original_model"

  echo -e "${RED}✗ Agent '${agent}' failed after ${max_attempts} attempts${NC}"
  echo -e "${YELLOW}  Check log: ${log_file}${NC}"
  return 1
}

# ── Build the prompt for each agent ───────────────────────────────────

build_prompt() {
  local agent="$1"

  case "$agent" in
    u-planner)
      cat << PROMPT
Task: ${TASK_MESSAGE}

## Your Role

Analyze the task and output a JSON pipeline configuration. Do NOT write any code or specs.

## Analysis Steps

1. Read the task description carefully
2. Search codebase for files/patterns mentioned in the task (use glob/grep)
3. Check if existing OpenSpec proposals cover this: \`npx openspec list\`
4. Estimate scope: how many files, apps, services are likely affected?
5. Check if DB migrations are likely needed (schema changes, new tables)
6. Check if API surface changes are needed (new/modified endpoints)

## Profile Guide

- **quick-fix**: Typos, config tweaks, minor fixes, single-file edits, slide updates. 1-3 files affected.
- **standard**: Normal features, moderate changes. Multiple files, single app. May need OpenSpec.
- **complex**: Multi-service changes, DB migrations, API changes, new agents. Cross-app impact.
- **merge**: Merge main into feature branch, verify test coverage and docs. Use for merge/sync/rebase requests.
- **merge+test**: Merge + fill test gaps. Use when merge may reveal coverage issues.
- **merge+deploy**: Full merge-to-deploy. Use when the goal is to ship a completed feature (merge, test, deploy).

## Output

Write ONLY a JSON file to \`pipeline-plan.json\` (in the repo root) with this exact structure:

\`\`\`json
{
  "profile": "quick-fix|standard|complex",
  "reasoning": "Brief explanation of complexity assessment",
  "agents": ["list", "of", "agents", "to", "run"],
  "skip_openspec": true,
  "estimated_files": 5,
  "apps_affected": ["core"],
  "needs_migration": false,
  "needs_api_change": false,
  "is_agent_task": false,
  "timeout_overrides": {},
  "model_overrides": {}
}
\`\`\`

**Fields**:
- \`is_agent_task\`: set to \`true\` ONLY when the task creates, modifies, or significantly changes a **brama platform agent** (any app in \`brama-agents/\` with \`-agent\` suffix). When true, the pipeline auto-injects an auditor step after the coder to verify agent compliance. NOTE: changes to pipeline agent configs in \`.opencode/agents/\` (u-coder.md, u-architect.md etc.) are NOT agent tasks — those are pipeline configuration changes.

Agent options: u-planner, u-architect, u-coder, u-auditor, u-validator, u-tester, e2e, u-merger, u-documenter, u-translater, u-summarizer.
For quick-fix: typically ["u-coder", "u-validator", "u-summarizer"].
For standard: typically ["u-architect", "u-coder", "u-validator", "u-tester", "u-summarizer"].
For complex: add "u-auditor" and increase timeouts.
For merge: typically ["u-merger", "u-summarizer"]. For merge+test: add "u-tester". For merge+deploy: add "u-tester" and "u-deployer".
Note: documenter is NOT needed by default — u-coder handles docs via tasks.md "Documentation" section. Only add documenter if documentation is the primary task.
Always keep "u-summarizer" as the final agent unless this is an explicit single-agent run.

**IMPORTANT**: If an existing OpenSpec proposal already has \`tasks.md\` — exclude \`architect\` from agents. The coder reads specs directly from \`openspec/changes/<id>/\`. If the task says "Implement openspec change ..." — the spec is ready, skip architect.

Write the file and nothing else. Do not explain your reasoning outside the JSON.
PROMPT
      ;;
    u-architect)
      local architect_timeout
      architect_timeout=$(get_timeout "u-architect")
      local architect_timeout_min=$(( architect_timeout / 60 ))

      local scope_instruction=""
      case "$PIPELINE_PROFILE" in
        quick-fix)
          scope_instruction="
## Scope Note
This is a quick-fix task. Create ONLY proposal.md with a one-paragraph description.
Skip design.md, tasks.md, and spec deltas entirely.
Do NOT explore the codebase beyond the files mentioned in the task.
Target: complete in under 5 minutes.
"
          ;;
        standard)
          scope_instruction="
## Scope Note
Create a MINIMAL proposal: proposal.md and tasks.md only.
Skip design.md and detailed spec deltas unless the task involves new API endpoints or DB schema changes.
Limit codebase exploration to files directly mentioned in the task — do NOT read more than 10 files.
Focus on getting to the coder stage quickly.
Target: complete in under 20 minutes.
"
          ;;
        complex)
          scope_instruction="
## Scope Note
Create full proposal with design.md. Limit codebase exploration to 20 files max.
Focus spec deltas on changed components only, not the entire spec tree.
"
          ;;
      esac

      cat << PROMPT
Task: ${TASK_MESSAGE}
${scope_instruction}
Time budget: ~${architect_timeout_min} minutes. Plan your work accordingly.

## Instructions

1. Read \`openspec/AGENTS.md\` for full OpenSpec conventions
2. Read \`openspec/project.md\` to understand current project state
3. Run \`openspec list\` — if a proposal for this task already exists, update it instead of creating a duplicate
4. Explore the codebase with grep/glob/read to understand current implementation
5. Search existing requirements: \`rg -n "Requirement:|Scenario:" openspec/specs\`
6. Scaffold under \`openspec/changes/<id>/\`: proposal.md, design.md, tasks.md, and spec deltas
7. Validate: \`openspec validate <id> --strict\` — fix all issues before finishing

## Handoff

Update \`.opencode/pipeline/handoff.md\` with your section:
- Change ID created
- Apps affected (core, knowledge-agent, hello-agent, news-maker-agent)
- Whether DB changes (migrations) are needed
- API surface changes (new/modified endpoints)
- Key design decisions and risks
PROMPT
      ;;
    u-coder)
      cat << PROMPT
Task: ${TASK_MESSAGE}

## Instructions

1. Read \`.opencode/pipeline/handoff.md\` for context from the architect (if it exists)
2. Read the full proposal: \`openspec/changes/<id>/proposal.md\`, \`design.md\`, \`tasks.md\`
3. Read spec deltas in \`openspec/changes/<id>/specs/\`
4. Implement tasks from \`tasks.md\` sequentially, marking each \`- [x]\` when done
5. Follow existing codebase patterns — read surrounding code before writing

## Per-App Make Targets

| App | Test | Analyse | CS Check | Migrate |
|-----|------|---------|----------|---------|
| apps/brama-core/ | make test | make analyse | make cs-check | make migrate |
| apps/knowledge-agent/ | make knowledge-test | make knowledge-analyse | make knowledge-cs-check | make knowledge-migrate |
| apps/hello-agent/ | make hello-test | make hello-analyse | make hello-cs-check | — |
| apps/news-maker-agent/ | make news-test | make news-analyse | make news-cs-check | make news-migrate |

## Important

- After creating migration files, run \`make migrate\` (or the per-app variant)
- If migration fails, fix it before proceeding
- Keep edits minimal and focused on the spec
- **ONLY implement tasks from tasks.md** — if all are marked \`[x]\`, update handoff and STOP
- **NEVER delete or modify files that are NOT mentioned in tasks.md**
- If you notice work that needs doing but is outside scope (new proposals, docs, refactoring, pre-existing bugs) — **do NOT do it**. Instead add a \`## Recommended follow-up tasks\` section in your handoff with: task title, why it's needed, which files/area
- If you are changing more than ~15 source files, STOP and re-read tasks.md — you are likely out of scope

## Handoff

Update \`.opencode/pipeline/handoff.md\` — Coder section:
- List every file created or modified
- List any migration files created
- Note deviations from the spec (with reasoning)
PROMPT
      ;;
    u-validator)
      cat << PROMPT
Read \`.opencode/pipeline/handoff.md\` for the task description and full pipeline context.

## Instructions

1. From handoff.md, determine which apps were changed
2. Run validation ONLY for changed apps (not the entire codebase):

| App | CS Check | Analyse |
|-----|----------|---------|
| apps/brama-core/ | make cs-check | make analyse |
| apps/knowledge-agent/ | make knowledge-cs-check | make knowledge-analyse |
| apps/hello-agent/ | make hello-cs-check | make hello-analyse |
| apps/news-maker-agent/ | make news-cs-check | make news-analyse |

3. For CS issues: run the corresponding \`cs-fix\` target first, then verify
4. For PHPStan errors: read the failing file, understand the error, fix manually
5. If \`phpstan-baseline.neon\` exists, preserve existing suppressions — only fix NEW errors
6. Re-run all checks after fixes. Iterate until zero errors.

## Handoff

Update \`.opencode/pipeline/handoff.md\` — Validator section:
- PHPStan result: pass/fail (per app)
- CS-check result: pass/fail (per app)
- Files fixed (list)
PROMPT
      ;;
    u-tester)
      cat << PROMPT
Read \`.opencode/pipeline/handoff.md\` for the task description and full pipeline context.

## Instructions

1. From handoff.md, determine which apps and files were changed
2. Run the relevant test suite(s) — ONLY for changed apps:

| App | Unit+Functional | Convention |
|-----|-----------------|------------|
| apps/brama-core/ | make test | make conventions-test |
| apps/knowledge-agent/ | make knowledge-test | make conventions-test |
| apps/hello-agent/ | make hello-test | make conventions-test |
| apps/news-maker-agent/ | make news-test | make conventions-test |

3. If tests fail: read the failing test AND the tested code, determine root cause, fix it
4. Check test coverage for new code — if new classes/methods have no tests, write them
5. Follow existing test patterns: Codeception Cest format for PHP, pytest for Python
6. If the change touches agent config (manifest, compose), also run: \`make conventions-test\`

### E2E Coverage Check (step 7)

7. If the change touches UI (templates, controllers, CSS, JS, admin pages):
   a. Read \`docs/agent-requirements/e2e-cuj-matrix.md\`
   b. Check: does a CUJ row exist for this feature?
   c. If CUJ exists but E2E test is missing → write E2E test + Page Object
   d. If no CUJ exists for a new UI feature → add CUJ row to matrix + write test
   e. Follow Page Object patterns in \`tests/e2e/support/pages/\`
   f. Register new Page Objects in \`tests/e2e/codecept.conf.js\`
   g. Tag tests: \`@admin\` for UI, \`@smoke\` for API, plus feature tag

8. If E2E infra is available (\`make e2e-prepare\` succeeds): run \`make e2e\`
9. If E2E infra is NOT available: write tests anyway, note in handoff
10. Run full unit/functional suite one last time to ensure nothing is broken

## Test Conventions

- PHP test files: \`tests/Unit/\` and \`tests/Functional/\`, mirroring \`src/\` structure
- Test naming: \`*Cest.php\` (Codeception), test methods with \`test\` prefix
- E2E test files: \`tests/e2e/tests/admin/*_test.js\`, Codecept.js Feature/Scenario
- E2E Page Objects: \`tests/e2e/support/pages/*.js\`, encapsulate selectors and actions
- Reference: \`docs/agent-requirements/test-cases.md\` (TC-01..TC-05)
- Reference: \`docs/agent-requirements/e2e-testing.md\` for isolation patterns
- Reference: \`docs/agent-requirements/e2e-cuj-matrix.md\` for CUJ coverage

## Handoff

Update \`.opencode/pipeline/handoff.md\` — Tester section:
- Test results per suite (passed/failed/skipped counts)
- New tests written (file paths)
- Tests updated and why
- E2E coverage: CUJ check result, new E2E tests written (or "N/A — no UI changes")
PROMPT
      ;;
    e2e)
      cat << PROMPT
Read \`.opencode/pipeline/handoff.md\` for the task description and full pipeline context.

## Instructions

You are the E2E test runner. Your job is to run browser-based E2E tests and report results.

### Pre-flight

1. Check if E2E infra is available: run \`make e2e-prepare\`
   - If it succeeds: proceed to step 2
   - If it fails (Docker not available, containers can't start): report "E2E SKIPPED — infra unavailable" in handoff and exit

### Run E2E

2. Run the full E2E suite: \`make e2e\`
3. If tests fail:
   a. Read failing test file and related Page Object
   b. Read the tested page/controller to understand what changed
   c. Fix the E2E test if it's a test issue (outdated selector, timing, etc.)
   d. Fix the production code if it's a real bug — keep changes minimal
   e. Re-run \`make e2e\` to verify

### CUJ Verification

4. Read \`docs/agent-requirements/e2e-cuj-matrix.md\`
5. From handoff.md, check which UI features were changed
6. Verify every changed UI feature has a CUJ with a passing E2E test
7. If CUJ is missing: flag as WARN in handoff (do NOT create tests — tester does that)

### Cleanup

8. Run \`make e2e-cleanup\` to stop E2E containers

## Handoff

Update \`.opencode/pipeline/handoff.md\` — E2E section:
- E2E result: PASS / FAIL / SKIPPED (with reason)
- Tests run: total/passed/failed/skipped
- CUJ coverage: checked / gaps found
- Fixes applied (if any)
PROMPT
      ;;
    u-documenter)
      cat << PROMPT
Read \`.opencode/pipeline/handoff.md\` for the task description and full pipeline context.

## Instructions

1. From handoff.md, understand what was implemented and which apps were changed
2. Read the OpenSpec proposal (\`proposal.md\`, \`design.md\`) for what was implemented
3. Read \`.claude/skills/documentation/SKILL.md\` for documentation conventions
4. Read \`INDEX.md\` (project root) to understand the current doc landscape
5. Determine what documentation needs to be created or updated:
   - New agent → \`docs/agents/ua/\` and \`docs/agents/en/\`
   - New feature → \`docs/features/ua/\` and \`docs/features/en/\`
   - API changes → \`docs/specs/\`
   - Config changes → \`docs/local-dev.md\` or agent-specific docs
6. Write/update documentation using templates from the documentation skill
7. Update \`INDEX.md\` with new entries

## Validation

After writing docs, verify:
- No .md files in intermediate directories (dirs with subdirs must NOT contain .md files)
- \`INDEX.md\` updated with all new entries
- Both \`ua/\` and \`en/\` versions exist for bilingual sections with identical structure

## Handoff

Update \`.opencode/pipeline/handoff.md\` — Documenter section:
- Docs created/updated (file paths)
- Final status: PIPELINE COMPLETE
PROMPT
      ;;
    u-merger)
      cat << PROMPT
Task: ${TASK_MESSAGE}

Read \`.opencode/pipeline/handoff.md\` for context from previous pipeline stages (if any).

## Instructions

1. Verify working tree is clean: \`git status --porcelain\`
   - If non-empty → STOP: "Cannot merge: working tree has uncommitted changes"
2. Verify you are NOT on main/master: \`git branch --show-current\`
   - If on main → STOP: "Refusing to merge: already on main branch"
3. Fetch latest main: \`git fetch origin main\`
4. Check if merge is needed: \`git merge-base --is-ancestor origin/main HEAD\`
   - If already up-to-date (exit 0) → skip to step 6
5. Attempt merge: \`git merge origin/main --no-edit\`
   - If clean → proceed to step 6
   - If conflicts:
     a. List conflicted files: \`git diff --name-only --diff-filter=U\`
     b. Classify each conflict:
        - Lock files (composer.lock, package-lock.json) → accept theirs, regenerate
        - Whitespace-only → accept main
        - Import ordering → merge both, sort alphabetically
        - Auto-generated files → accept theirs
        - Code logic → resolve ONLY if intent is clearly non-overlapping
        - Architecture/config conflicts → STOP, \`git merge --abort\`, set status: blocked
     c. After resolving all: \`git add\` each file and commit
     d. If any unresolvable: \`git merge --abort\`, report details in handoff
6. Run smoke tests for changed apps:

| App | Test Command |
|-----|-------------|
| apps/brama-core/ | make test |
| apps/knowledge-agent/ | make knowledge-test |
| apps/hello-agent/ | make hello-test |
| apps/dev-reporter-agent/ | make dev-reporter-test |
| apps/news-maker-agent/ | make news-test |
| apps/wiki-agent/ | make wiki-test |

   - Map changed files (\`git diff origin/main...HEAD --name-only\`) to apps
   - Run ONLY for apps with changes
   - If tests fail: report but do NOT fix (tester handles that)
7. Coverage analysis:
   a. List changed source files (exclude tests): \`git diff origin/main...HEAD --name-only | grep -E '\\.(php|py|js|ts|tsx)\$' | grep -v -E '(tests/|test_|\\.test\\.|\\.spec\\.|Test\\.php|Cest\\.php)'\`
   b. For each, check if a corresponding test file exists
   c. Calculate ratio: covered/total
   d. Warn if < 0.7, block if < 0.3
8. Documentation check:
   a. Check if changed features have docs in \`docs/\`
   b. Check if skill files are current
   c. Advisory only — report gaps but do not block

## Safety Rules

- NEVER use \`git push --force\` or \`--force-with-lease\`
- NEVER merge directly into main — merge main INTO feature branch
- NEVER use \`git rebase\` — use merge for traceability
- If tests fail, do NOT attempt fixes — report for tester

## Handoff

Update \`.opencode/pipeline/handoff.md\` — Merger section:
- **Status**: ready | needs-tests | needs-docs | blocked | failed
- **Merge result**: clean | conflicts-resolved | conflicts-unresolvable | already-up-to-date
- **Conflicts resolved**: [list with strategy]
- **Conflicts unresolved**: [list with both sides]
- **Smoke tests**: pass | fail (per app)
- **Coverage**: X/Y files covered (ratio)
- **Uncovered files**: [list]
- **Documentation gaps**: [list or "none"]
- **Recommendation**: proceed to deploy | chain tester | chain documenter | manual intervention needed
PROMPT
      ;;
    u-auditor)
      local task_summary
      task_summary=$(echo "$TASK_MESSAGE" | head -1 | cut -c1-120)
      cat << PROMPT
Task: Audit the changes from pipeline — ${task_summary}

## Instructions

1. Read \`.opencode/pipeline/handoff.md\` to understand what was changed
2. Read \`.claude/skills/agent-auditor/SKILL.md\` for the audit checklist
3. Determine which agents/apps were modified
4. Run the appropriate checklist (PHP or Python) against the changed agents
5. Run the platform checklist for cross-cutting concerns
6. Generate an audit report following \`.claude/skills/agent-auditor/references/report-template.md\`

## Focus Areas

- Structure & Build (S): Dockerfile, composer.json, service config
- Testing (T): test coverage, PHPStan, CS compliance
- Configuration (C): manifest endpoint, Agent Card fields
- Security (X): no hardcoded secrets, proper auth
- Observability (O): trace context, Langfuse integration, structured logging
- Documentation (D): bilingual docs exist, INDEX.md updated

## Output

Write audit report to \`.opencode/pipeline/reports/${TIMESTAMP}_audit.md\`
Update \`.opencode/pipeline/handoff.md\` with audit summary and verdict (PASS/WARN/FAIL)
PROMPT
      ;;
    u-summarizer)
      cat << PROMPT
Task: Create the final task summary for this pipeline run.

## Instructions

1. Read \`.opencode/pipeline/handoff.md\` for cross-agent context.
2. Read \`${CHECKPOINT_FILE}\` to see which agents actually ran, their statuses, durations, and commits.
3. Generate the telemetry markdown block via: \`agentic-development/lib/cost-tracker.sh summary-block --workflow builder --task-slug "${TASK_SLUG:-task}"\`
4. Read the available logs in \`.opencode/pipeline/logs/${TIMESTAMP}_*.log\`.
5. Read \`.opencode/pipeline/reports/${TIMESTAMP}.md\` if it already exists.
6. Write the final markdown summary to \`${TASK_SUMMARY_FILE}\`.
7. Write the report in Ukrainian.

## Required Report Structure

\`\`\`md
# Task Summary: <title>

## Загальний статус
- Статус пайплайну
- Гілка
- Pipeline ID
- Workflow

## Telemetry
<paste generated telemetry block here>

## Агенти
### <agent>
- Що зробив
- Які були складнощі або блокери
- Що залишилось виправити або доробити

## Що треба доробити
- ...

## Рекомендації по оптимізації
> Ця секція ОБОВ'ЯЗКОВА якщо є: фейли агентів, аномальна кількість токенів (>500K на агента), аномальна тривалість (>15хв на агента), retry storm (3+ retry одного агента), pipeline FAIL/INCOMPLETE.

### 🔴/🟡 [Тип аномалії]: [опис]
**Що сталось:**
**Вплив:**
**Рекомендація:**

## Пропозиція до наступної задачі
- Назва задачі
- Чому її варто створити зараз
- Очікуваний результат
\`\`\`

## Rules

- Include only agents that actually worked on the task.
- If an agent log shows no blocking issues, say so explicitly.
- If the pipeline failed, clearly name the failing agent and the unfinished work.
- **If any anomaly detected** (agent failed, timeout, >500K tokens per agent, >15min per agent, 3+ retries, pipeline FAIL): add \`## Рекомендації по оптимізації\` section with concrete fixes. Use 🔴 for blocking, 🟡 for warnings.
- If pipeline completed normally with no anomalies: SKIP the optimization section entirely.
- End with exactly one concrete proposed follow-up task.
- Do not overwrite other reports; write only to \`${TASK_SUMMARY_FILE}\`.

## Handoff

Update \`.opencode/pipeline/handoff.md\` — Summarizer section:
- Status
- Summary file path
- Final recommendation for next task
PROMPT
      ;;
  esac
}

# ── Initialize handoff file ──────────────────────────────────────────

init_handoff() {
  mkdir -p "$PIPELINE_DIR"

  if [[ -n "$TASK_DIR" ]]; then
    HANDOFF_FILE="$(foundry_handoff_file "$TASK_DIR")"
  else
    local slug="${TASK_SLUG:-$(_task_slug "$TASK_MESSAGE" 2>/dev/null || echo "task")}"
    HANDOFF_FILE="$PIPELINE_DIR/handoff-${TIMESTAMP}-${slug}.md"
  fi

  # Only create new handoff if not resuming (--from)
  if [[ -n "$FROM_AGENT" && -L "$HANDOFF_LINK" && -f "$HANDOFF_LINK" ]]; then
    # Resuming: use whatever the symlink points to
    HANDOFF_FILE="$(readlink -f "$HANDOFF_LINK")"
    echo -e "${BLUE}Using existing handoff file (resuming from ${FROM_AGENT})${NC}"
    echo -e "${DIM}  ${HANDOFF_FILE}${NC}"
    return
  fi

  # Point the symlink to this task's handoff
  rm -f "$HANDOFF_LINK"
  ln -s "$HANDOFF_FILE" "$HANDOFF_LINK"

  cat > "$HANDOFF_FILE" << EOF
# Pipeline Handoff

- **Task**: ${TASK_MESSAGE}
- **Started**: $(date '+%Y-%m-%d %H:%M:%S')
- **Branch**: ${branch}
- **Pipeline ID**: ${TIMESTAMP}

---

## Architect

- **Status**: pending
- **Change ID**: —
- **Apps affected**: —
- **DB changes**: —
- **API changes**: —

## Coder

- **Status**: pending
- **Files modified**: —
- **Migrations created**: —
- **Deviations**: —

## Validator

- **Status**: pending
- **PHPStan**: —
- **CS-check**: —
- **Files fixed**: —

## Tester

- **Status**: pending
- **Test results**: —
- **New tests written**: —

## Auditor

- **Status**: pending
- **Verdict**: —
- **Recommendations**: —

## Documenter

- **Status**: pending
- **Docs created/updated**: —

## Summarizer

- **Status**: pending
- **Summary file**: —
- **Next task recommendation**: —

---

EOF
}

# ── Main execution ───────────────────────────────────────────────────

main() {
  debug_log "main" "Pipeline starting" "pid=$$" "args=$*"
  echo ""
  echo -e "${CYAN}╔══════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║${NC}     ${YELLOW}OpenCode Multi-Agent Pipeline v2${NC}             ${CYAN}║${NC}"
  echo -e "${CYAN}╚══════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "${BLUE}Task:${NC} ${TASK_MESSAGE}"
  echo -e "${BLUE}Time:${NC} $(date '+%Y-%m-%d %H:%M:%S')"
  echo ""

  # Pre-flight
  preflight

  # Environment check (validates runtimes, services, per-app deps)
  env_check

  # Setup branch
  branch=$(setup_branch)
  echo -e "${BLUE}Branch:${NC} ${branch}"

  # Ensure we're on main/master before creating a new feature branch
  local current_branch
  current_branch=$(git -C "$REPO_ROOT" branch --show-current 2>/dev/null || true)
  local main_branch
  main_branch=$(git -C "$REPO_ROOT" symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@refs/remotes/origin/@@' || echo "main")

  # ── Branch checkout logic ──────────────────────────────────────────
  # Case 1: Already on the target branch → skip checkout entirely
  # Case 2: Target branch exists → switch to it
  # Case 3: Target branch doesn't exist → create from main
  #
  # Fail explicitly if untracked files block checkout (don't silently die).

  debug_log "git" "Branch checkout" "current=$current_branch" "target=$branch" "main=$main_branch"
  if [[ "$current_branch" == "$branch" ]]; then
    # Already on the target feature branch — nothing to do
    echo -e "${GREEN}✓ Already on target branch: ${branch}${NC}"
    debug_log "git" "Already on target branch — skipping checkout"
  else
    # Need to switch branches
    debug_log "git" "Switching branches" "from=$current_branch" "to=$branch"
    if ! git -C "$REPO_ROOT" rev-parse --verify "$branch" &>/dev/null; then
      # New branch — must be on main/master to create it
      if [[ "$current_branch" != "$main_branch" && "$current_branch" != "master" ]]; then
        if git -C "$REPO_ROOT" diff-index --quiet HEAD -- 2>/dev/null; then
          echo -e "${YELLOW}⚠ Not on ${main_branch} (on ${current_branch}), auto-switching...${NC}"
          if ! git -C "$REPO_ROOT" checkout "$main_branch" 2>/dev/null; then
            echo -e "${RED}✗ Failed to switch to ${main_branch}${NC}"
            [[ "$TASK_LIFECYCLE" == true ]] && foundry_set_state_status "$TASK_DIR" "stopped" "branch_switch_failed" ""
            exit 1
          fi
          current_branch="$main_branch"
        else
          echo -e "${RED}✗ Cannot create branch: must be on ${main_branch} (currently on ${current_branch})${NC}"
          echo -e "${RED}  Working tree has uncommitted changes — cannot auto-switch${NC}"
          echo -e "${RED}  Run: git stash && git checkout ${main_branch}${NC}"
          [[ "$TASK_LIFECYCLE" == true ]] && foundry_set_state_status "$TASK_DIR" "stopped" "dirty_workspace" ""
          exit 1
        fi
      fi
      echo -e "${GREEN}✓ On ${main_branch} — safe to create task branch${NC}"
    fi

    # Create or switch to branch (with retry for lock contention)
    local branch_ok=false
    local checkout_error=""
    for _try in 1 2 3 4 5; do
      checkout_error=""
      if git -C "$REPO_ROOT" rev-parse --verify "$branch" &>/dev/null; then
        # Branch exists — switch to it (or re-create in worktree mode)
        if [[ -f "$REPO_ROOT/.git" ]]; then
          git -C "$REPO_ROOT" branch -D "$branch" 2>/dev/null || true
          checkout_error=$(git -C "$REPO_ROOT" checkout -b "$branch" 2>&1) && { branch_ok=true; break; }
        else
          checkout_error=$(git -C "$REPO_ROOT" checkout "$branch" 2>&1) && {
            echo -e "${YELLOW}Switched to existing branch: ${branch}${NC}"
            branch_ok=true; break
          }
        fi
      else
        checkout_error=$(git -C "$REPO_ROOT" checkout -b "$branch" 2>&1) && {
          echo -e "${GREEN}Created branch: ${branch}${NC}"
          branch_ok=true; break
        }
      fi

      # Check if failure is due to untracked files (not recoverable by retry)
      if echo "$checkout_error" | grep -q "untracked working tree files would be overwritten"; then
        local blocking_files
        blocking_files=$(echo "$checkout_error" | grep -A50 "untracked working tree files" | grep "^\t" | head -10)
        echo -e "${RED}✗ Cannot switch to branch ${branch}: untracked files would be overwritten${NC}"
        echo -e "${RED}  Blocking files:${NC}"
        echo "$blocking_files" | while read -r f; do echo -e "${RED}    $f${NC}"; done
        echo -e "${RED}  Fix: remove or commit these files, then retry${NC}"
        [[ "$TASK_LIFECYCLE" == true ]] && {
          foundry_set_state_status "$TASK_DIR" "stopped" "untracked_files_block_checkout" ""
          pipeline_task_append_event "$TASK_DIR" "task_stopped" \
            "Untracked files block checkout to $branch: $(echo "$blocking_files" | tr '\n' ', ')" ""
        }
        exit 1
      fi

      echo -e "${YELLOW}Git lock contention (attempt ${_try}/5), retrying in ${_try}s...${NC}"
      sleep "$_try"
    done
    if [[ "$branch_ok" != true ]]; then
      echo -e "${RED}Failed to create/switch branch after 5 attempts${NC}"
      [[ -n "$checkout_error" ]] && echo -e "${RED}  Last error: ${checkout_error}${NC}"
      [[ "$TASK_LIFECYCLE" == true ]] && foundry_set_state_status "$TASK_DIR" "stopped" "branch_checkout_failed" ""
      exit 1
    fi
  fi

  # Move task to in-progress (if using task file lifecycle)
  _task_move_to_in_progress

  # Initialize handoff
  init_handoff

  # Emit task start event
  local task_title
  task_title=$(echo "$TASK_MESSAGE" | grep -m1 '^# ' | sed 's/^# //' || echo "$TASK_MESSAGE" | head -c 60)
  emit_event "TASK_START" "task=${task_title}"

  # Initialize artifacts & checkpoint
  local slug="${TASK_SLUG:-$(_task_slug "$TASK_MESSAGE")}"
  init_artifacts "$slug" "$branch"

  # Auto-resume: if --resume and checkpoint exists, determine FROM_AGENT
  if [[ "$RESUME_MODE" == true && -z "$FROM_AGENT" ]]; then
    local resume_from
    resume_from=$(get_resume_agent)
    if [[ -n "$resume_from" && "$resume_from" != "u-architect" ]]; then
      FROM_AGENT="$resume_from"
      echo -e "${YELLOW}Auto-resuming from: ${FROM_AGENT}${NC}"
      echo -e "${DIM}Checkpoint:${NC}"
      print_checkpoint_summary
      echo ""
    fi
  fi

  # Apply profile or run planner
  if [[ -n "$PIPELINE_PROFILE" ]]; then
    apply_profile "$PIPELINE_PROFILE"
  elif [[ "$SKIP_PLANNER" != true && "$SKIP_ARCHITECT" != true && -z "$FROM_AGENT" && -z "$ONLY_AGENT" ]]; then
    echo -e "${CYAN}Running planner agent to analyze task complexity...${NC}"
    local planner_prompt
    planner_prompt=$(build_prompt "u-planner")
    local planner_start
    planner_start=$(date +%s)
    debug_log "planner" "Starting planner"
    if run_agent "u-planner" "$planner_prompt"; then
      local planner_dur=$(( $(date +%s) - planner_start ))
      echo -e "${GREEN}✓ Planner completed in ${planner_dur}s${NC}"
      debug_log "planner" "Planner completed" "duration=${planner_dur}s" "plan_exists=$(test -f "$PLAN_FILE" && echo yes || echo no)"
      if apply_plan "$PLAN_FILE"; then
        write_checkpoint "u-planner" "done" "$planner_dur" ""
        debug_log "planner" "Plan applied" "file=$PLAN_FILE"
      fi
    else
      echo -e "${YELLOW}⚠ Planner failed, using standard pipeline${NC}"
      debug_log "planner" "PLANNER FAILED — using standard pipeline"
      write_checkpoint "u-planner" "failed" "$(( $(date +%s) - planner_start ))" ""
    fi
    # Archive plan.json for this task, then clean up git
    if [[ -f "$PLAN_FILE" ]]; then
      local plan_archive="$LOG_DIR/${TIMESTAMP}_plan.json"
      cp "$PLAN_FILE" "$plan_archive" 2>/dev/null || true
    fi
    git -C "$REPO_ROOT" checkout -- "$PLAN_FILE" 2>/dev/null || true
    echo ""
  fi

  # Get agents to run
  local agents_to_run
  agents_to_run=$(get_agents_to_run)
  set_planned_agents $agents_to_run

  # Write ALL planned agents to state.json as "pending" so monitor shows the full plan
  if [[ "$TASK_LIFECYCLE" == true && -n "$TASK_DIR" ]]; then
    foundry_state_set_planned_agents "$TASK_DIR" "${PIPELINE_PROFILE:-standard}" $agents_to_run
  fi

  echo ""
  debug_log "pipeline" "Agents resolved" "agents=$(echo "$agents_to_run" | tr '\n' ',')" "profile=${PIPELINE_PROFILE:-standard}"
  echo -e "${BLUE}Agents to run:${NC} $(echo "$agents_to_run" | tr '\n' ' ')"
  echo ""

  # Telegram: pipeline started
  send_telegram "🚀 <b>Pipeline started</b>
📋 <i>${TASK_MESSAGE}</i>
🌿 Branch: <code>${branch}</code>
🤖 Agents: $(echo "$agents_to_run" | tr '\n' ' ')"

  # Task slug for commits
  local task_slug
  task_slug=$(echo "$TASK_MESSAGE" | cut -c1-60)

  local pipeline_start
  pipeline_start=$(date +%s)

  # Run each agent
  local failed=false
  local failed_agent=""
  local should_run_summarizer=false
  if echo "$agents_to_run" | grep -qx 'summarizer'; then
    should_run_summarizer=true
  fi
  for agent in $agents_to_run; do
    debug_log "loop" "=== Agent loop iteration ===" "agent=$agent"
    if [[ "$TASK_LIFECYCLE" == true && -n "$TASK_DIR" ]]; then
      foundry_set_state_status "$TASK_DIR" "in_progress" "$agent" "$agent"
    fi

    local prompt
    prompt=$(build_prompt "$agent")
    debug_log "loop" "Prompt built" "agent=$agent" "prompt_length=${#prompt}"

    local agent_start
    agent_start=$(date +%s)

    # Log file for this agent run
    local agent_log="$LOG_DIR/${TIMESTAMP}_${agent}.log"

    local run_exit=0
    debug_log "loop" "Calling run_agent" "agent=$agent" "log=$agent_log"
    run_agent "$agent" "$prompt" || run_exit=$?
    debug_log "loop" "run_agent returned" "agent=$agent" "exit=$run_exit" "duration=$(($(date +%s) - agent_start))s"

    if [[ $run_exit -eq 0 ]]; then
      local agent_dur=$(( $(date +%s) - agent_start ))

      send_telegram "✅ <b>${agent}</b> completed (${agent_dur}s)
📋 <i>${TASK_MESSAGE}</i>"

      # Auto-commit after each successful agent
      commit_agent_work "$agent" "$task_slug"
      local commit_hash
      commit_hash=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo "")

      # Save checkpoint & artifacts (with token data)
      local agent_tokens
      agent_tokens=$(get_agent_tokens "$agent")
      write_checkpoint "$agent" "done" "$agent_dur" "$commit_hash" "$agent_tokens"
      save_agent_artifact "$agent" "$agent_log"

      # Update state.json with agent telemetry
      local _in_tok _out_tok _cost
      _in_tok=$(echo "$agent_tokens" | jq -r '.input_tokens // 0' 2>/dev/null || echo 0)
      _out_tok=$(echo "$agent_tokens" | jq -r '.output_tokens // 0' 2>/dev/null || echo 0)
      _cost=$(echo "$agent_tokens" | jq -r '.cost // 0' 2>/dev/null || echo 0)
      if [[ "$TASK_LIFECYCLE" == true && -n "$TASK_DIR" ]]; then
        foundry_state_upsert_agent "$TASK_DIR" "$agent" "done" "" "$agent_dur" "$_in_tok" "$_out_tok" "$_cost" "1" ""
      fi

      # Stage gate: verify coder produced actual code changes
      if [[ "$agent" == "u-coder" ]]; then
        if ! verify_coder_output; then
          local agent_dur_fail=$(( $(date +%s) - agent_start ))
          local agent_tokens
      agent_tokens=$(get_agent_tokens "$agent")
          write_checkpoint "$agent" "failed-no-code" "$agent_dur_fail" "" "$agent_tokens"
          failed=true
          failed_agent="$agent (no code produced)"

          send_telegram "❌ <b>${agent}</b> produced NO CODE CHANGES
📋 <i>${TASK_MESSAGE}</i>
⚠️ Coder stage ran but did not modify any source files. Check agent permissions/logs."

          echo -e "${RED}Pipeline stopped: coder produced no code changes${NC}"
          echo -e "${YELLOW}Check log for permission errors (e.g. worktree external_directory rejections)${NC}"
          break
        fi

        run_migrations
      fi

      echo ""
    elif [[ $run_exit -eq 75 ]]; then
      # HITL: Agent is waiting for answers
      local agent_dur=$(( $(date +%s) - agent_start ))

      # Auto-commit agent's partial work
      commit_agent_work "$agent" "$task_slug"
      local commit_hash
      commit_hash=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo "")

      local agent_tokens
      agent_tokens=$(get_agent_tokens "$agent")
      write_checkpoint "$agent" "waiting_answer" "$agent_dur" "$commit_hash" "$agent_tokens"
      save_agent_artifact "$agent" "$agent_log"

      emit_event "TASK_WAITING" "agent=${agent}|duration=${agent_dur}s"

      # Check if continue_on_wait=true — pipeline continues to next agent
      local _continue_on_wait="false"
      if [[ -n "$TASK_DIR" ]]; then
        local _task_plan="$TASK_DIR/pipeline-plan.json"
        if [[ -f "$_task_plan" ]]; then
          _continue_on_wait=$(jq -r '.continue_on_wait // false' "$_task_plan" 2>/dev/null || echo "false")
        elif [[ -f "$PLAN_FILE" ]]; then
          _continue_on_wait=$(jq -r '.continue_on_wait // false' "$PLAN_FILE" 2>/dev/null || echo "false")
        fi
      fi

      if [[ "$_continue_on_wait" == "true" ]]; then
        # Pipeline continues — task stays in waiting_answer but next agents run
        echo -e "${CYAN}  continue_on_wait=true — continuing to next agent${NC}"
        echo -e "${YELLOW}  Agent ${agent} waiting for answers in background${NC}"
        echo ""
        # Don't break — continue the loop
      else
        # Move task to waiting_answer state (already done in run_agent, but ensure it)
        if [[ "$TASK_LIFECYCLE" == true && -n "$TASK_DIR" ]]; then
          foundry_set_state_status "$TASK_DIR" "waiting_answer" "$agent" "$agent"
        fi

        echo -e "${YELLOW}Pipeline paused at agent: ${agent} (waiting for answers)${NC}"
        echo -e "${YELLOW}Answer questions: ./agentic-development/foundry.sh answer ${TASK_SLUG:-<slug>}${NC}"
        echo -e "${YELLOW}Resume pipeline:  ./agentic-development/foundry.sh resume-qa ${TASK_SLUG:-<slug>}${NC}"
        break
      fi
    else
      local agent_dur=$(( $(date +%s) - agent_start ))

      # Save failed checkpoint & artifact (with token data)
      local agent_tokens
      agent_tokens=$(get_agent_tokens "$agent")
      write_checkpoint "$agent" "failed" "$agent_dur" "" "$agent_tokens"
      save_agent_artifact "$agent" "$agent_log"

      # Update state.json with failed agent telemetry
      local _in_tok _out_tok _cost
      _in_tok=$(echo "$agent_tokens" | jq -r '.input_tokens // 0' 2>/dev/null || echo 0)
      _out_tok=$(echo "$agent_tokens" | jq -r '.output_tokens // 0' 2>/dev/null || echo 0)
      _cost=$(echo "$agent_tokens" | jq -r '.cost // 0' 2>/dev/null || echo 0)
      if [[ "$TASK_LIFECYCLE" == true && -n "$TASK_DIR" ]]; then
        foundry_state_upsert_agent "$TASK_DIR" "$agent" "failed" "" "$agent_dur" "$_in_tok" "$_out_tok" "$_cost" "1" ""
      fi

      failed=true
      failed_agent="$agent"

      send_telegram "❌ <b>${agent}</b> FAILED (${agent_dur}s)
📋 <i>${TASK_MESSAGE}</i>
🔄 Resume: <code>./scripts/pipeline.sh --from ${agent} --branch ${branch} \"...\"</code>"

      echo -e "${RED}Pipeline stopped at agent: ${agent}${NC}"
      echo -e "${YELLOW}Resume with: ./scripts/pipeline.sh --from ${agent} --branch ${branch} \"${TASK_MESSAGE}\"${NC}"
      break
    fi
  done

  if $failed && $should_run_summarizer && [[ "$failed_agent" != "u-summarizer" ]]; then
    echo ""
    echo -e "${YELLOW}Running u-summarizer after failure to capture partial task status...${NC}"

    local summary_prompt
    summary_prompt=$(build_prompt "u-summarizer")
    local summary_start
    summary_start=$(date +%s)
    local summary_log="$LOG_DIR/${TIMESTAMP}_u-summarizer.log"

    if run_agent "u-summarizer" "$summary_prompt"; then
      local summary_dur=$(( $(date +%s) - summary_start ))
      commit_agent_work "u-summarizer" "$task_slug"
      local summary_commit
      summary_commit=$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo "")
      local summary_tokens
      summary_tokens=$(get_agent_tokens "u-summarizer")
      write_checkpoint "u-summarizer" "done" "$summary_dur" "$summary_commit" "$summary_tokens"
      save_agent_artifact "u-summarizer" "$summary_log"
    else
      local summary_dur=$(( $(date +%s) - summary_start ))
      local summary_tokens
      summary_tokens=$(get_agent_tokens "u-summarizer")
      write_checkpoint "u-summarizer" "failed" "$summary_dur" "" "$summary_tokens"
      save_agent_artifact "u-summarizer" "$summary_log"
      echo -e "${YELLOW}⚠ Summarizer failed after pipeline failure; keeping original failure status${NC}"
    fi
  fi

  local total_duration=$(( $(date +%s) - pipeline_start ))

  # Generate report
  local report_file="$REPORT_DIR/${TIMESTAMP}.md"
  {
    echo "# Pipeline Report — ${TIMESTAMP}"
    echo ""
    echo "- **Task**: ${TASK_MESSAGE}"
    echo "- **Branch**: ${branch}"
    if $failed; then
      echo "- **Status**: FAILED at ${failed_agent}"
    else
      echo "- **Status**: COMPLETED"
    fi
    echo "- **Completed**: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "- **Total duration**: ${total_duration}s ($(( total_duration / 60 )) min)"
    echo ""
    echo "## Agent Results"
    echo ""
    echo "| Agent | Status | Duration | Input Tok | Output Tok | Cache Read | Cache Write |"
    echo "|-------|--------|----------|-----------|------------|------------|-------------|"
    # Enhanced report lines with token data from opencode session export
    for agent in $agents_to_run; do
      local agent_tokens
      agent_tokens=$(get_agent_tokens "$agent")
      local in_tok out_tok cache_r cache_w
      in_tok=$(echo "$agent_tokens" | jq -r '.input_tokens // 0' 2>/dev/null || echo 0)
      out_tok=$(echo "$agent_tokens" | jq -r '.output_tokens // 0' 2>/dev/null || echo 0)
      cache_r=$(echo "$agent_tokens" | jq -r '.cache_read // 0' 2>/dev/null || echo 0)
      cache_w=$(echo "$agent_tokens" | jq -r '.cache_write // 0' 2>/dev/null || echo 0)

      # Get status from checkpoint
      local agent_status agent_dur
      agent_status=$(jq -r --arg a "$agent" '.agents[$a].status // "skipped"' "$CHECKPOINT_FILE" 2>/dev/null || echo "unknown")
      agent_dur=$(jq -r --arg a "$agent" '.agents[$a].duration // 0' "$CHECKPOINT_FILE" 2>/dev/null || echo "0")

      local status_icon="✓"
      if [[ "$agent_status" != "done" ]]; then
        status_icon="✗"
      fi
      echo "| ${agent} | ${status_icon} ${agent_status} | ${agent_dur}s | ${in_tok} | ${out_tok} | ${cache_r} | ${cache_w} |"
    done
    echo ""
    echo "- **Total pipeline cost**: \$${CUMULATIVE_COST}"
    if [[ -n "$PIPELINE_MAX_COST" ]]; then
      echo "- **Cost budget**: \$${PIPELINE_MAX_COST}"
    fi
    if [[ -n "$PIPELINE_PROFILE" ]]; then
      echo "- **Profile**: ${PIPELINE_PROFILE}"
    fi
    echo ""
    echo "## OpenCode Stats"
    echo '```'
    opencode stats 2>/dev/null || echo "(stats unavailable)"
    echo '```'
    echo ""
    echo "## Task Summary"
    echo ""
    echo "- **Summary file**: ${TASK_SUMMARY_FILE}"
  } > "$report_file"

  # Append cost breakdown to task summary file
  if [[ -f "$TASK_SUMMARY_FILE" ]]; then
    {
      echo ""
      echo "---"
      echo ""
      echo "## Вартість пайплайну"
      echo ""
      echo "| Агент | Тривалість | Input | Output | Cache Read | Cache Write | ≈ Вартість |"
      echo "|-------|-----------|-------|--------|------------|-------------|-----------|"
      local grand_in=0 grand_out=0 grand_cr=0 grand_cw=0
      for agent in $agents_to_run; do
        local agent_tokens
        agent_tokens=$(get_agent_tokens "$agent")
        local in_tok out_tok cache_r cache_w agent_dur_s
        in_tok=$(echo "$agent_tokens" | jq -r '.input_tokens // 0' 2>/dev/null || echo 0)
        out_tok=$(echo "$agent_tokens" | jq -r '.output_tokens // 0' 2>/dev/null || echo 0)
        cache_r=$(echo "$agent_tokens" | jq -r '.cache_read // 0' 2>/dev/null || echo 0)
        cache_w=$(echo "$agent_tokens" | jq -r '.cache_write // 0' 2>/dev/null || echo 0)
        agent_dur_s=$(jq -r --arg a "$agent" '.agents[$a].duration // 0' "$CHECKPOINT_FILE" 2>/dev/null || echo "0")
        local agent_cost
        agent_cost=$(awk "BEGIN { printf \"%.3f\", ($in_tok * 3 + $out_tok * 15 + $cache_r * 0.30 + $cache_w * 3.75) / 1000000 }")
        grand_in=$((grand_in + in_tok))
        grand_out=$((grand_out + out_tok))
        grand_cr=$((grand_cr + cache_r))
        grand_cw=$((grand_cw + cache_w))
        local dur_fmt="${agent_dur_s}s"
        (( agent_dur_s >= 60 )) && dur_fmt="$(( agent_dur_s / 60 ))m $(( agent_dur_s % 60 ))s"
        echo "| ${agent} | ${dur_fmt} | ${in_tok} | ${out_tok} | ${cache_r} | ${cache_w} | \$${agent_cost} |"
      done
      local grand_cost
      grand_cost=$(awk "BEGIN { printf \"%.3f\", ($grand_in * 3 + $grand_out * 15 + $grand_cr * 0.30 + $grand_cw * 3.75) / 1000000 }")
      echo "| **Всього** | **$(( total_duration / 60 ))m** | **${grand_in}** | **${grand_out}** | **${grand_cr}** | **${grand_cw}** | **\$${grand_cost}** |"
      echo ""
      echo "_Вартість розрахована приблизно за тарифами Claude Sonnet (\$3/\$15 per 1M in/out, \$0.30/\$3.75 cache r/w)._"
    } >> "$TASK_SUMMARY_FILE"
    echo -e "${GREEN}✓ Cost breakdown appended to ${TASK_SUMMARY_FILE}${NC}"
  fi

  # Webhook
  if [[ -n "$WEBHOOK_URL" ]]; then
    local payload="{\"pipeline_id\":\"${TIMESTAMP}\",\"task\":\"${TASK_MESSAGE}\",\"branch\":\"${branch}\",\"status\":\"$(if $failed; then echo failed; else echo completed; fi)\",\"duration_seconds\":${total_duration}}"
    curl -s -X POST "$WEBHOOK_URL" \
      -H "Content-Type: application/json" \
      -d "$payload" &>/dev/null || echo -e "${YELLOW}⚠ Webhook notification failed${NC}"
  fi

  # Send report to dev-reporter-agent (best-effort)
  echo -e "${BLUE}Sending pipeline report to dev-reporter-agent...${NC}"
  if $failed; then
    send_report_to_agent "failed" "$failed_agent" "$total_duration"
  else
    send_report_to_agent "completed" "" "$total_duration"
  fi

  # Telegram: final summary
  if $failed; then
    send_telegram "🔴 <b>Pipeline FAILED</b> at <b>${failed_agent}</b>
📋 <i>${TASK_MESSAGE}</i>
🌿 Branch: <code>${branch}</code>
⏱ Duration: $(( total_duration / 60 ))m"
  else
    send_telegram "🟢 <b>Pipeline COMPLETED</b>
📋 <i>${TASK_MESSAGE}</i>
🌿 Branch: <code>${branch}</code>
⏱ Duration: $(( total_duration / 60 ))m"
  fi

  # Archive per-task handoff to logs dir (survives worktree cleanup)
  if [[ -f "$HANDOFF_FILE" && "$HANDOFF_FILE" != "$HANDOFF_LINK" ]]; then
    cp "$HANDOFF_FILE" "$LOG_DIR/${TIMESTAMP}_handoff.md" 2>/dev/null || true
  fi

  # Task file lifecycle: finalize BEFORE push/PR so task never stays in_progress
  # Check if task is in waiting_answer state (HITL pause)
  local current_task_status=""
  if [[ "$TASK_LIFECYCLE" == true && -n "$TASK_DIR" ]]; then
    current_task_status=$(foundry_state_field "$TASK_DIR" status 2>/dev/null || echo "")
  fi

  if [[ "$current_task_status" == "waiting_answer" ]]; then
    # Task is paused for HITL — do not mark as failed or completed
    echo -e "${YELLOW}Task paused in waiting_answer state — not finalizing${NC}"
  elif $failed; then
    _task_move_to_failed "$branch" "$total_duration"
  else
    _task_move_to_done "$branch" "$total_duration"
  fi

  # Create Pull Request (only on success and if we have a summary)
  # This is best-effort — task is already marked completed/failed above
  if ! $failed && [[ -n "$branch" && "$branch" != "main" ]]; then
    echo -e "${BLUE}Creating Pull Request...${NC}"
    local pr_title pr_body pr_url
    pr_title=$(echo "$TASK_MESSAGE" | head -1 | sed 's/^#\+ *//' | sed 's/^<!-- .* -->//' | xargs | cut -c1-70)

    if [[ -f "$TASK_SUMMARY_FILE" ]]; then
      pr_body=$(cat "$TASK_SUMMARY_FILE")
    else
      pr_body="Pipeline completed for: ${TASK_MESSAGE}"
    fi

    # Push branch to remote (timeout prevents indefinite hangs)
    if timeout 60 git -C "$REPO_ROOT" push -u origin "$branch" 2>/dev/null; then
      pr_url=$(timeout 30 gh pr create \
        --base main \
        --head "$branch" \
        --title "[pipeline] ${pr_title}" \
        --body "$pr_body" 2>/dev/null || true)

      if [[ -n "$pr_url" ]]; then
        echo -e "${GREEN}✓ PR created: ${pr_url}${NC}"
        emit_event "PR_CREATED" "url=${pr_url}|branch=${branch}"
      else
        echo -e "${YELLOW}⚠ PR creation failed (branch pushed, create PR manually)${NC}"
      fi
    else
      echo -e "${YELLOW}⚠ Git push failed — PR not created${NC}"
    fi
  fi

  # Final status
  echo ""
  echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
  if [[ "$current_task_status" == "waiting_answer" ]]; then
    emit_event "TASK_WAITING" "duration=$(( total_duration / 60 ))m"
    echo -e "${YELLOW}Pipeline PAUSED — waiting for human answers${NC}"
    echo -e "${BLUE}Branch:${NC}  ${branch}"
    echo -e "${BLUE}Report:${NC}  ${report_file}"
    echo -e "${BLUE}Handoff:${NC} ${HANDOFF_FILE}"
    echo -e "${YELLOW}Answer:${NC}  ./agentic-development/foundry.sh answer ${TASK_SLUG:-<slug>}"
    echo -e "${YELLOW}Resume:${NC}  ./agentic-development/foundry.sh resume-qa ${TASK_SLUG:-<slug>}"
    exit 75
  elif $failed; then
    emit_event "TASK_FAIL" "agent=${failed_agent}|duration=$(( total_duration / 60 ))m"
    echo -e "${RED}Pipeline FAILED at agent: ${failed_agent}${NC}"
    echo -e "${BLUE}Report:${NC}  ${report_file}"
    [[ -f "$TASK_SUMMARY_FILE" ]] && echo -e "${BLUE}Task MD:${NC} ${TASK_SUMMARY_FILE}"
    echo -e "${YELLOW}Logs:${NC}    ${LOG_DIR}/${TIMESTAMP}_*.log${NC}"
    exit 1
  else
    emit_event "TASK_DONE" "duration=$(( total_duration / 60 ))m"
    echo -e "${GREEN}Pipeline COMPLETED in $(( total_duration / 60 )) min${NC}"
    echo -e "${BLUE}Branch:${NC}  ${branch}"
    echo -e "${BLUE}Report:${NC}  ${report_file}"
    echo -e "${BLUE}Task MD:${NC} ${TASK_SUMMARY_FILE}"
    echo -e "${BLUE}Handoff:${NC} ${HANDOFF_FILE}"
    echo -e "${BLUE}Logs:${NC}    ${LOG_DIR}/${TIMESTAMP}_*.log${NC}"
  fi
}

main
