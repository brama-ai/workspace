#!/bin/sh
set -eu

if [ "${MIGRATE_ON_START:-1}" = "1" ]; then
  echo "[knowledge-agent] Running startup migrations (best effort)..."
  if ! php bin/console doctrine:migrations:migrate --no-interaction --allow-no-migration; then
    echo "[knowledge-agent] Startup migrations failed; continuing container startup."
  fi
fi

exec "$@"

