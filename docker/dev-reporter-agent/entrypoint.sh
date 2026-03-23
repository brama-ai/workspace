#!/bin/sh
set -eu

if [ "${MIGRATE_ON_START:-1}" = "1" ]; then
  echo "[dev-reporter-agent] Running startup migrations (best effort)..."
  if ! php bin/console doctrine:migrations:migrate --no-interaction --allow-no-migration; then
    echo "[dev-reporter-agent] Startup migrations failed; continuing container startup."
  fi
fi

exec "$@"
