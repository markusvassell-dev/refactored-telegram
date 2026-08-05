#!/bin/sh
# The single entrypoint for both services.
#
# Railway reads one `railway.json` from the repository root and applies it to
# every service built from that repository. A second file — `railway.worker.json`
# — is not picked up unless each service is individually pointed at it, which is
# a setting nobody remembers to change and which fails silently when missed: the
# worker starts the web service's command, health-checks the web service's path,
# and reports a health-check failure that has nothing to do with either.
#
# So the role travels with the service's own variables instead, alongside the
# database URL and everything else that already has to be set there.
#
#   SERVICE_ROLE=web      (default)
#   SERVICE_ROLE=worker

set -eu

ROLE="${SERVICE_ROLE:-web}"

# Defaulting is right — an unset role should not be a broken deployment — but it
# must be visible. A worker whose SERVICE_ROLE never got set starts a second web
# service, which looks entirely healthy: it passes its health check, serves the
# application, and drains no work at all. Nothing else in the log would say so.
if [ -z "${SERVICE_ROLE:-}" ]; then
  echo "NOTE: SERVICE_ROLE is not set; starting as the web service."
  echo "      If this is meant to be the worker, set SERVICE_ROLE=worker in this"
  echo "      service's variables. Two web services would leave the job queue"
  echo "      running empty, with nothing reporting a problem."
fi

case "$ROLE" in
  web)
    exec ./scripts/start-web.sh
    ;;
  worker)
    exec ./scripts/start-worker.sh
    ;;
  *)
    echo "FATAL: SERVICE_ROLE is '${ROLE}', which is not a service this image can start." >&2
    echo "       Set SERVICE_ROLE to 'web' or 'worker' in the service's variables." >&2
    exit 1
    ;;
esac
