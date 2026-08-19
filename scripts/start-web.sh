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

echo "==> Checking configuration"
check_environment || exit 1

echo "==> Applying database migrations"
# Redacted: Prisma prints the datasource, password included, on every boot.
if ! run_redacted pnpm db:migrate; then
  echo "" >&2
  echo "FATAL: database migrations failed; the web server was not started." >&2
  echo "       This is the reason behind a 'healthcheck failed' deploy — the" >&2
  echo "       process exits here, so nothing ever answers /api/health." >&2
  echo "       Check DATABASE_URL and that the Postgres service is running." >&2
  exit 1
fi

echo "==> Migrations applied"

# The schema is not the application. Without this the deployment comes up with
# no approved templates, no pricing rules, no date rules and no system
# settings — every screen renders, nothing can be generated, and the Templates
# page reports all eight document types as awaiting a template that is sitting
# in the image the whole time.
#
# The seed is idempotent: it upserts, and skips a template version that already
# exists rather than rewriting it, which the database forbids anyway. Sample
# clients and the sample engagement are skipped when APP_ENV=production.
echo "==> Registering approved templates and reference data"
# Redacted for the same reason: a Prisma failure here prints the datasource too.
if ! run_redacted pnpm db:seed; then
  echo "" >&2
  echo "FATAL: seeding failed; the web server was not started." >&2
  echo "       The schema is migrated but the approved templates, pricing" >&2
  echo "       rules and date rules are missing or incomplete, so no document" >&2
  echo "       could be generated. Starting anyway would hide that behind" >&2
  echo "       screens that render but cannot do any work." >&2
  exit 1
fi

echo "==> Starting the web server"
exec pnpm --filter @element/web start
