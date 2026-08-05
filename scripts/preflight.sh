# Shared start-up checks. Sourced, not executed.
#
# Kept in one place because the two role scripts must fail the same way: an
# operator reading a deploy log should not have to know which service produced
# it to understand what to fix.

# A variable that is set but empty is a different fault from one that was never
# set, and it has a different fix. On Railway the empty case means a reference
# like ${{Postgres.DATABASE_URL}} was saved but did not resolve — the service
# name does not match, or the database is in another project or environment.
# Saying "not set" there sends someone to re-add a variable that is already
# there, which is exactly what they will have just done.
require_database_url() {
  if [ -n "${DATABASE_URL:-}" ]; then
    return 0
  fi

  if [ -n "${DATABASE_URL+isset}" ]; then
    echo "FATAL: DATABASE_URL is set but empty." >&2
    echo "       The variable exists, so this is a reference that did not resolve —" >&2
    echo "       not a missing variable. On Railway, check that:" >&2
    echo "         - the database service is named exactly what the reference says," >&2
    echo '           e.g. ${{Postgres.DATABASE_URL}} needs a service named Postgres;' >&2
    echo "         - the database is in the same project and environment;" >&2
    echo "         - the reference was added with the variable picker. A reference" >&2
    echo "           pasted as text is not always stored as one." >&2
    echo "       Copying the connection string from the database's own Variables" >&2
    echo "       tab works too, and is the quickest way to get moving." >&2
  else
    echo "FATAL: DATABASE_URL is not set." >&2
    echo "       On Railway, add a variable referencing the Postgres service:" >&2
    echo '         DATABASE_URL = ${{Postgres.DATABASE_URL}}' >&2
  fi

  return 1
}

# Working copies live here. An unwritable directory is not fatal — Karbon holds
# the authoritative document and a reviewer can regenerate — but it is worth
# saying out loud, because the symptom otherwise appears much later as a failed
# generation job.
check_document_storage() {
  [ -n "${DOCUMENT_STORAGE_DIRECTORY:-}" ] || return 0

  if ( mkdir -p "$DOCUMENT_STORAGE_DIRECTORY" && touch "$DOCUMENT_STORAGE_DIRECTORY/.writable" ) 2>/dev/null; then
    rm -f "$DOCUMENT_STORAGE_DIRECTORY/.writable"
    return 0
  fi

  echo "WARNING: ${DOCUMENT_STORAGE_DIRECTORY} is not writable by this container." >&2
  echo "         Generated documents will fail to store. If a volume is mounted" >&2
  echo "         there, it is owned by root and this process runs as uid 10001." >&2
}

# The environment is otherwise validated lazily, on the first request that needs
# it. That turns a missing variable into a 500 on every page of an apparently
# healthy deployment, because the health check does not touch configuration.
check_environment() {
  pnpm exec tsx --tsconfig tsconfig.json scripts/check-env.ts
}
