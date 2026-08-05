#!/bin/sh
# Worker service entrypoint.
#
# The worker does not run migrations. The web service owns the schema, so two
# services never race for the same advisory lock and a worker can never apply a
# migration the running web code does not expect.
#
# It waits for the schema instead: on a first deployment the worker and the web
# service start together, and a worker that boots against an empty database
# would spend its first minutes logging failures.

set -eu

. ./scripts/preflight.sh

# Railway probes the port it assigned, not the one the worker would pick for
# itself. PORT wins when the platform sets it; WORKER_HEALTH_PORT remains the
# local default.
PORT="${PORT:-${WORKER_HEALTH_PORT:-3001}}"
export PORT

echo "==> Element Engagements worker"
echo "    APP_ENV=${APP_ENV:-unset}  TEST_MODE=${TEST_MODE:-unset}"
echo "    health endpoint on port ${PORT}"

require_database_url || exit 1
check_document_storage

echo "==> Checking configuration"
check_environment || exit 1

echo "==> Waiting for the schema the web service applies"
attempt=0
until pnpm exec prisma migrate status --schema packages/database/prisma/schema.prisma >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    echo "WARNING: the schema is still not ready after 30 attempts; starting anyway." >&2
    echo "         The worker will retry its queries; check the web service's" >&2
    echo "         deploy log to see whether its migrations succeeded." >&2
    break
  fi
  sleep 2
done

echo "==> Starting the worker"
exec pnpm --filter @element/worker start
