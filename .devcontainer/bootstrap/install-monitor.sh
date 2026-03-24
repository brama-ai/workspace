#!/usr/bin/env bash
set -euo pipefail

MONITOR_DIR="/workspaces/brama/agentic-development/monitor"

if [[ ! -f "$MONITOR_DIR/package.json" ]]; then
  echo "Monitor package.json not found, skipping."
  exit 0
fi

cd "$MONITOR_DIR"
npm install --no-audit --no-fund 2>&1
npm run build 2>&1

echo "Foundry monitor installed and built."
