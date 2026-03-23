#!/bin/sh
set -eu

if [ "${MIGRATE_ON_START:-1}" = "1" ]; then
  echo "[news-maker-agent] Running startup migrations (best effort)..."
  if ! alembic upgrade head; then
    echo "[news-maker-agent] Startup migrations failed; continuing container startup."
  fi
fi

exec "$@"

