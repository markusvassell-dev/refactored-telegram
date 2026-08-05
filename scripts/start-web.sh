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

. ./scripts/preflight.sh

PORT="${PORT:-3000}"
export PORT

echo "==> Element Engagements web"
echo "    APP_ENV=${APP_ENV:-unset}  NODE_ENV=${NODE_ENV:-unset}  TEST_MODE=${TEST_MODE:-unset}"
echo "    listening on port ${PORT}"

require_database_url || exit 1
check_document_storage

echo "==> Checking configuration"
check_environment || exit 1

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
