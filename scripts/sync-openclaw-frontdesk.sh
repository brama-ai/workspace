#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEMPLATE_DIR="$REPO_ROOT/brama-core/docs/templates/openclaw/frontdesk"
WORKSPACE_DIR="${WORKSPACE_DIR:-$REPO_ROOT/.local/openclaw/state/workspace}"

FILES=(
  "IDENTITY.md"
  "USER.md"
  "SOUL.md"
  "AGENTS.md"
  "TOOLS.md"
  "HEARTBEAT.md"
  "BOOTSTRAP.md"
  "MEMORY.md"
)

mkdir -p "$WORKSPACE_DIR"

for file in "${FILES[@]}"; do
  src="$TEMPLATE_DIR/$file"
  dst="$WORKSPACE_DIR/$file"

  if [ ! -f "$src" ]; then
    echo "Missing template file: $src" >&2
    exit 1
  fi

  cp "$src" "$dst"
done

echo "Synced OpenClaw frontdesk files to $WORKSPACE_DIR"
