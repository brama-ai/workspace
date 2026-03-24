#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

cd "${REPO_ROOT}"

echo "==> Installing E2E dependencies..."
if [ -f brama-core/tests/e2e/package.json ]; then
  (
    cd brama-core/tests/e2e
    npm install
  )
fi
