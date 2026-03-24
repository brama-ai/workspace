#!/usr/bin/env bash
# =============================================================================
# external-agent.sh — External agent workspace management
# =============================================================================
#
# Manages external agent checkouts under agents/<agent-name>/ and their
# compose fragments under compose.fragments/<agent-name>.yaml.
#
# Commands:
#   list                      List detected external agent compose fragments
#   up   <agent-name>         Start/update a named external agent
#   down <agent-name>         Stop a named external agent
#   clone <git-url> <name>    Clone an agent repo into agents/<name>
#
# Usage (via Makefile):
#   make external-agent-list
#   make external-agent-up   name=my-agent
#   make external-agent-down name=my-agent
#   make external-agent-clone repo=https://github.com/org/my-agent name=my-agent
#
# See docs/guides/external-agents/ for the full onboarding guide.
# =============================================================================

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FRAGMENTS_DIR="$REPO_ROOT/docker/compose.fragments"
PROJECTS_DIR="$REPO_ROOT/projects"

# ── Helpers ──────────────────────────────────────────────────────────────────

info()  { printf '  \033[1;34m→\033[0m %s\n' "$*"; }
ok()    { printf '  \033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '  \033[1;33m!\033[0m %s\n' "$*"; }
fail()  { printf '  \033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# Build the compose command with all current fragments included
compose_cmd() {
    local agent_files fragment_files override_file override_flag
    agent_files=$(cd "$REPO_ROOT" && ls docker/compose.agent-*.yaml 2>/dev/null | sort | sed 's/^/-f /' | tr '\n' ' ')
    fragment_files=$(cd "$REPO_ROOT" && ls docker/compose.fragments/*.yaml 2>/dev/null | sort | sed 's/^/-f /' | tr '\n' ' ')
    override_file=$(cd "$REPO_ROOT" && ls docker/compose.override.yaml docker/compose.override.yml 2>/dev/null | head -1 || true)
    override_flag=""
    [ -n "$override_file" ] && override_flag="-f $override_file"

    echo "docker compose --project-directory . \
        -f docker/compose.yaml \
        -f docker/compose.core.yaml \
        $agent_files \
        $fragment_files \
        -f docker/compose.langfuse.yaml \
        -f docker/compose.openclaw.yaml \
        -f docker/compose.slides.yaml \
        $override_flag"
}

# ── Commands ─────────────────────────────────────────────────────────────────

cmd_list() {
    echo ""
    echo "  External agent compose fragments:"
    echo "  ─────────────────────────────────"

    local found=0
    for fragment in "$FRAGMENTS_DIR"/*.yaml; do
        [ -f "$fragment" ] || continue
        local name
        name="$(basename "$fragment" .yaml)"
        local checkout="$PROJECTS_DIR/$name"
        local checkout_status="(no checkout)"
        [ -d "$checkout" ] && checkout_status="agents/$name"
        printf '  %-30s %s\n' "$name" "$checkout_status"
        found=1
    done

    if [ "$found" -eq 0 ]; then
        echo "  (none — add fragments to docker/compose.fragments/)"
        echo ""
        echo "  To onboard an external agent:"
        echo "    make external-agent-clone repo=<git-url> name=<agent-name>"
        echo "    make external-agent-up name=<agent-name>"
    fi
    echo ""
}

cmd_up() {
    local name="$1"
    local fragment="$FRAGMENTS_DIR/$name.yaml"

    [ -f "$fragment" ] || fail "Fragment not found: docker/docker/compose.fragments/$name.yaml\n  Run: make external-agent-clone repo=<url> name=$name"

    info "Starting external agent: $name"
    local compose
    compose="$(compose_cmd)"
    # shellcheck disable=SC2086
    (cd "$REPO_ROOT" && $compose up --build -d "$name")
    ok "Agent $name is up"
    echo ""
    echo "  Verify:"
    echo "    docker compose logs -f $name"
    echo "    curl -s http://localhost:<port>/health"
    echo "    make agent-discover"
}

cmd_down() {
    local name="$1"
    local fragment="$FRAGMENTS_DIR/$name.yaml"

    [ -f "$fragment" ] || fail "Fragment not found: docker/docker/compose.fragments/$name.yaml"

    info "Stopping external agent: $name"
    local compose
    compose="$(compose_cmd)"
    # shellcheck disable=SC2086
    (cd "$REPO_ROOT" && $compose stop "$name")
    ok "Agent $name stopped"
}

cmd_clone() {
    local repo="$1"
    local name="$2"
    local checkout="$PROJECTS_DIR/$name"
    local fragment="$FRAGMENTS_DIR/$name.yaml"

    # Validate agent name (kebab-case, ends with -agent)
    if ! echo "$name" | grep -qE '^[a-z][a-z0-9-]*-agent$'; then
        fail "Agent name must be kebab-case and end with '-agent' (e.g. my-agent). Got: $name"
    fi

    # Clone the repository
    if [ -d "$checkout" ]; then
        warn "Checkout already exists at agents/$name — pulling latest..."
        git -C "$checkout" pull
        ok "Updated agents/$name"
    else
        info "Cloning $repo into agents/$name..."
        mkdir -p "$PROJECTS_DIR"
        git clone "$repo" "$checkout"
        ok "Cloned into agents/$name"
    fi

    # Copy compose fragment if available
    local agent_fragment="$checkout/compose.fragment.yaml"
    if [ -f "$agent_fragment" ]; then
        cp "$agent_fragment" "$fragment"
        ok "Installed compose fragment: docker/compose.fragments/$name.yaml"
    else
        warn "No compose.fragment.yaml found in $checkout"
        warn "Create docker/compose.fragments/$name.yaml manually."
        warn "See templates/agent/compose.fragment.yaml for reference."
    fi

    echo ""
    echo "  Next steps:"
    echo "    1. Review docker/compose.fragments/$name.yaml"
    echo "    2. Add any required env vars to agents/$name/.env.local"
    echo "    3. make external-agent-up name=$name"
    echo "    4. make agent-discover"
    echo ""
    echo "  See docs/guides/external-agents/ for the full onboarding guide."
}

# ── Dispatch ─────────────────────────────────────────────────────────────────

COMMAND="${1:-list}"
shift || true

case "$COMMAND" in
    list)  cmd_list ;;
    up)    cmd_up   "${1:-}" ;;
    down)  cmd_down "${1:-}" ;;
    clone) cmd_clone "${1:-}" "${2:-}" ;;
    *)
        fail "Unknown command: $COMMAND. Use: list | up <name> | down <name> | clone <repo> <name>"
        ;;
esac
