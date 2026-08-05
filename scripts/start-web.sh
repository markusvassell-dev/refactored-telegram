#!/bin/sh
# Web service entrypoint.
#
# Railway reports every start-up problem as "healthcheck failed", which points
# at the wrong thing: the health endpoint is fine, the process simply never got
# far enough to listen. The usual cause is that `prisma migrate deploy` could
# not reach the database, and `migrate && start` then short-circuits silently.
#
# This script names the reason instead, in the deploy log, where an operator
# will actually look.

set -eu

PORT="${PORT:-3000}"
export PORT

echo "==> Element Engagements web"
echo "    APP_ENV=${APP_ENV:-unset}  NODE_ENV=${NODE_ENV:-unset}  TEST_MODE=${TEST_MODE:-unset}"
echo "    listening on port ${PORT}"

if [ -z "${DATABASE_URL:-}" ]; then
  echo "FATAL: DATABASE_URL is not set." >&2
  echo "       On Railway, add a variable referencing the Postgres service:" >&2
  echo '         DATABASE_URL = ${{Postgres.DATABASE_URL}}' >&2
  exit 1
fi

# A working copy that cannot be written is not fatal — Karbon holds the
# authoritative document and the reviewer can regenerate — but it is worth
# saying out loud, because the symptom otherwise appears much later as a
# failed generation job.
if [ -n "${DOCUMENT_STORAGE_DIRECTORY:-}" ]; then
  if ! ( mkdir -p "$DOCUMENT_STORAGE_DIRECTORY" && touch "$DOCUMENT_STORAGE_DIRECTORY/.writable" ) 2>/dev/null; then
    echo "WARNING: ${DOCUMENT_STORAGE_DIRECTORY} is not writable by this container." >&2
    echo "         Generated documents will fail to store. If a volume is mounted" >&2
    echo "         there, it is owned by root and this process runs as uid 10001." >&2
  else
    rm -f "$DOCUMENT_STORAGE_DIRECTORY/.writable"
  fi
fi

echo "==> Checking configuration"
if ! pnpm exec tsx --tsconfig tsconfig.json scripts/check-env.ts; then
  exit 1
fi

echo "==> Applying database migrations"
if ! pnpm db:migrate; then
  echo "" >&2
  echo "FATAL: database migrations failed; the web server was not started." >&2
  echo "       This is the reason behind a 'healthcheck failed' deploy — the" >&2
  echo "       process exits here, so nothing ever answers /api/health." >&2
  echo "       Check DATABASE_URL and that the Postgres service is running." >&2
  exit 1
fi

echo "==> Migrations applied; starting the web server"
exec pnpm --filter @element/web start
