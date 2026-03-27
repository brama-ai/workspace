#!/usr/bin/env bash
# Foundry — post-clone setup
# Run once after git clone to create local directories.
#
# Usage: ./agentic-development/foundry.sh setup
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/agentic-development/lib/foundry-common.sh"

# ── 1. Task directories root ────────────────────────────────────────
echo "Ensuring task-centric Foundry root at ${FOUNDRY_TASK_ROOT_REL}/ ..."
ensure_foundry_task_root

echo ""
echo "Foundry setup complete."
echo "  Queue tasks:  ./agentic-development/foundry.sh run \"your task\""
echo "  Monitor:      ./agentic-development/foundry.sh"
echo "  Runtime:      ./agentic-development/foundry.sh run \"your task\""
