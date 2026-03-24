#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:18080}"
KNOWLEDGE_URL="${KNOWLEDGE_URL:-http://localhost:18083}"
NEWS_URL="${NEWS_URL:-http://localhost:18084}"
HELLO_URL="${HELLO_URL:-http://localhost:18085}"
DEV_REPORTER_URL="${DEV_REPORTER_URL:-http://localhost:18087}"
OPENCLAW_URL="${OPENCLAW_URL:-http://localhost:28789}"
MAX_TIME="${E2E_ENV_CHECK_MAX_TIME:-8}"
RETRIES="${E2E_ENV_CHECK_RETRIES:-5}"
RETRY_DELAY="${E2E_ENV_CHECK_RETRY_DELAY:-2}"

info() { printf '==> %s\n' "$*"; }
ok() { printf '  [OK] %s\n' "$*"; }
warn() { printf '  [WARN] %s\n' "$*" >&2; }
fail() { printf '  [FAIL] %s\n' "$*" >&2; exit 1; }

require_tool() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required tool: $1"
}

check_http() {
  local name="$1"
  local url="$2"
  local expected="$3"
  local status
  local attempt=1

  while [ "$attempt" -le "$RETRIES" ]; do
    status="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time "$MAX_TIME" "$url" || true)"
    if [ "$status" = "$expected" ]; then
      ok "${name} is reachable at ${url}"
      return 0
    fi

    if [ "$attempt" -lt "$RETRIES" ]; then
      warn "${name} check attempt ${attempt}/${RETRIES} failed for ${url} with ${status:-curl-error}; retrying in ${RETRY_DELAY}s"
      sleep "$RETRY_DELAY"
    fi
    attempt=$((attempt + 1))
  done

  fail "${name} check failed: expected HTTP ${expected} from ${url}, got ${status:-curl-error}"
}

check_any_http() {
  local name="$1"
  shift
  local url
  local status
  local attempt=1

  while [ "$attempt" -le "$RETRIES" ]; do
    for url in "$@"; do
      status="$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 3 --max-time "$MAX_TIME" "$url" || true)"
      if [ "$status" = "200" ] || [ "$status" = "302" ] || [ "$status" = "307" ]; then
        ok "${name} is reachable at ${url} (HTTP ${status})"
        return 0
      fi
    done

    if [ "$attempt" -lt "$RETRIES" ]; then
      warn "${name} check attempt ${attempt}/${RETRIES} failed for all candidate URLs; retrying in ${RETRY_DELAY}s"
      sleep "$RETRY_DELAY"
    fi
    attempt=$((attempt + 1))
  done

  fail "${name} check failed for all candidate URLs: $*"
}

main() {
  info "Running E2E environment preflight"

  require_tool curl

  check_http "Core health" "${BASE_URL}/health" "200"
  check_http "Core readiness" "${BASE_URL}/health/ready" "200"
  check_http "Knowledge agent health" "${KNOWLEDGE_URL}/health" "200"
  check_http "News-maker agent health" "${NEWS_URL}/health" "200"
  check_http "Hello agent health" "${HELLO_URL}/health" "200"
  check_http "Dev-reporter agent health" "${DEV_REPORTER_URL}/health" "200"
  check_http "OpenClaw health" "${OPENCLAW_URL}/healthz" "200"
  check_any_http "OpenClaw UI" "${OPENCLAW_URL}/" "${OPENCLAW_URL}/api/channels/telegram/webhook"

  printf '\n'
  ok "E2E environment looks ready"
}

main "$@"
