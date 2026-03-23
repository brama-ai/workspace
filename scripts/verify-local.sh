#!/usr/bin/env bash
set -euo pipefail

ADMIN_BASE_URL="${ADMIN_BASE_URL:-http://localhost}"
ADMIN_LOGIN_URL="${ADMIN_LOGIN_URL:-${ADMIN_BASE_URL}/admin/login}"
LITELLM_URL="${LITELLM_URL:-http://litellm.localhost/ui/}"
LANDING_URL="${LANDING_URL:-http://localhost:8086/}"
ADMIN_USERNAME="${ADMIN_USERNAME:-admin}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-test-password}"
EDGE_AUTH_COOKIE_NAME="${EDGE_AUTH_COOKIE_NAME:-ACP_EDGE_TOKEN}"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

info() { printf '==> %s\n' "$*"; }
ok() { printf '  [OK] %s\n' "$*"; }
fail() { printf '  [FAIL] %s\n' "$*" >&2; exit 1; }

curl_body() {
  local url="$1"
  curl -fsSL --max-time 15 "$url"
}

curl_status() {
  local url="$1"
  curl -s -o /dev/null -w '%{http_code}' --max-time 15 "$url"
}

check_admin_login_page() {
  info "Checking admin login page"

  local body_file="$TMP_DIR/admin-login.html"
  local status
  status="$(curl -sS -o "$body_file" -w '%{http_code}' --max-time 15 "$ADMIN_LOGIN_URL")"
  [ "$status" = "200" ] || fail "Admin login returned HTTP $status: $ADMIN_LOGIN_URL"

  rg -q 'name="_username"' "$body_file" || fail "Admin login form is missing _username field"
  rg -q 'name="_password"' "$body_file" || fail "Admin login form is missing _password field"

  ok "Admin login page is reachable"
}

check_litellm() {
  info "Checking LiteLLM protected UI"

  local redirect
  redirect="$(curl -s -o /dev/null -w '%{redirect_url}' --max-time 15 "$LITELLM_URL")"
  [[ "$redirect" == *"/edge/auth/login"* ]] || fail "LiteLLM did not redirect to edge login: $redirect"

  local cookie_jar="$TMP_DIR/litellm.cookies"
  local auth_body="$TMP_DIR/litellm-auth-body.html"

  curl -sS -L \
    -c "$cookie_jar" \
    -o "$auth_body" \
    --max-time 20 \
    --data-urlencode "_username=${ADMIN_USERNAME}" \
    --data-urlencode "_password=${ADMIN_PASSWORD}" \
    "$redirect" >/dev/null

  rg -q "${EDGE_AUTH_COOKIE_NAME}" "$cookie_jar" || fail "LiteLLM auth did not set ${EDGE_AUTH_COOKIE_NAME}"

  local status
  status="$(curl -s -b "$cookie_jar" -o /dev/null -w '%{http_code}' --max-time 15 "$LITELLM_URL")"
  [ "$status" = "200" ] || fail "LiteLLM authenticated request returned HTTP $status"

  ok "LiteLLM UI is reachable after edge auth"
}

check_landing() {
  info "Checking landing page"

  local body_file="$TMP_DIR/landing.html"
  local status
  status="$(curl -sS -o "$body_file" -w '%{http_code}' --max-time 15 "$LANDING_URL")"
  [ "$status" = "200" ] || fail "Landing returned HTTP $status: $LANDING_URL"

  rg -qi 'coming soon' "$body_file" || fail "Landing placeholder text not found"

  ok "Landing endpoint is reachable"
}

main() {
  check_admin_login_page
  check_litellm
  check_landing
  printf '\n'
  ok "Local smoke verification passed"
}

main "$@"
