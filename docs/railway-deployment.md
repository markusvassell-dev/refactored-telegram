# Railway deployment

## Services

Three, from one repository:

| Service | `SERVICE_ROLE` | Notes |
| --- | --- | --- |
| **web** | `web` (the default) | Applies migrations, then starts. Owns the schema |
| **worker** | `worker` | Waits for the schema; never migrates. Needs LibreOffice, which the image provides |
| **PostgreSQL** | — | Railway plugin, version 16 |

Both application services build from the same `Dockerfile`, run the same start
command, and answer the same health path. Nothing is configured per service
except its variables.

No other service is justified. The job queue is Postgres-backed, so there is no
broker to run.

### One config file, one entrypoint

Railway reads a single `railway.json` from the repository root and applies it to
every service built from that repository. A second file has to be selected in
each service's settings, and when that is missed nothing says so — the worker
runs the web service's start command, is probed on the web service's health
path, and fails with a health-check error that has nothing to do with either.
That is the failure this repository originally shipped.

So the role travels with the service's own variables, next to `DATABASE_URL` and
everything else that has to be set there anyway:

```
SERVICE_ROLE=worker
```

`scripts/start.sh` dispatches on it, defaults to `web`, and refuses a value it
does not recognise rather than starting the wrong thing. The worker answers
`/api/health` and `/api/ready` as aliases of its own paths, so one health-check
path serves both.

### Ports

Neither service picks its own port. Railway assigns `PORT` and health-checks
that port; the web service passes it to `next start` and the worker listens on
it in place of `WORKER_HEALTH_PORT`. The image exposes one port for the same
reason — with two exposed, Railway's inference can probe the web service on
3001 and the worker on 3000, and mark both unhealthy while both are running
correctly.

### Why the web service migrates and the worker does not

One writer, so two services never race for the same advisory lock and a worker
can never apply a migration the running web code does not expect. The worker
polls `prisma migrate status` until the schema is there, then starts.

## Environment variables

Set on **both** the web and worker services unless noted.

### Required

| Variable | Notes |
| --- | --- |
| `DATABASE_URL` | Reference the Postgres plugin |
| `ENCRYPTION_KEY` | `openssl rand -hex 32`. Encrypts stored integration credentials — losing it means re-entering them |
| `SESSION_SECRET` | `openssl rand -hex 32`. Rotating it signs everyone out |
| `APP_BASE_URL` | Public URL; used in Karbon deep links |
| `APP_ENV` | `staging` or `production` |
| `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` | Required outside development — the app refuses to boot without them |
| `ENTRA_REDIRECT_URI` | `https://<your-domain>/api/auth/entra/callback`, registered identically in Entra |
| `BOOTSTRAP_ADMIN_EMAILS` | The first administrator. Required on a first deployment; see below |

#### The first administrator

Directory role mapping starts empty, so the first person to sign in gets a user
record and no roles — and granting a role requires an administrator who does
not exist yet. `BOOTSTRAP_ADMIN_EMAILS` breaks that deadlock: a listed address
is granted `ADMINISTRATOR` **after** Entra ID authenticates it, never before,
and the grant is written to the audit trail as `ROLE_GRANTED`.

It is the only path to a role without an existing administrator. Sign in once,
configure the directory role mapping under Settings, then clear the variable.

### Safety switches

| Variable | Default | Notes |
| --- | --- | --- |
| `TEST_MODE` | `true` | A floor. While set, the database cannot turn Test Mode off |
| `ALLOW_PRODUCTION_SENDING` | `false` | Must be `true` **and** armed by an administrator in Settings |
| `DEV_LOGIN_ENABLED` | `false` | The app refuses to boot with this set outside development |

Deploy first with the defaults. Verify. Only then turn Test Mode off and arm
sending.

### Integrations

**Vendor credentials are not environment variables.** A Karbon bearer token and
access key, and the Adobe Sign client id, secret and refresh token, are entered
on the Integrations screen, where they are encrypted with `ENCRYPTION_KEY`,
carry a sandbox-or-production flag, and every change is audited. That flag is
what Test Mode keys off; a credential supplied through the environment would
have no flag, and Test Mode's guarantee would become a convention.

What *is* environment configuration: `KARBON_API_BASE_URL`,
`ADOBE_SIGN_API_BASE_URL` (region-specific), `ADOBE_SIGN_REDIRECT_URI`, and the
two webhook secrets — `KARBON_WEBHOOK_SECRET` and `ADOBE_SIGN_WEBHOOK_SECRET` —
which are values this application chooses and gives to the vendor, not
credentials the vendor issues.

See the full list in `.env.example`.

## Database

```bash
pnpm db:migrate      # prisma migrate deploy — the web service runs this on boot
pnpm db:seed         # idempotent; safe to re-run
```

The seed registers the approved templates, the default price and date rules,
and the system settings. Sample clients and the sample engagement are skipped
when `APP_ENV=production`.

Run `pnpm templates:normalize` **before** building if any template changed; the
normalised files are committed, so a normal deploy does not need it.

## Volumes

Attach a volume at `DOCUMENT_STORAGE_DIRECTORY`
(`/var/lib/element-engagements/storage`) on both services. It holds working
copies only — Karbon keeps the authoritative documents — and the purge job
clears it on the retention schedule. Sizing: roughly 2 MB per live engagement.

Without a volume the application still works; a working copy simply disappears
on redeploy and the reviewer regenerates or opens the Karbon copy.

## Health checks

| Endpoint | Meaning |
| --- | --- |
| `GET /api/health` | Liveness. Does not touch the database, so a database blip does not trigger a restart loop |
| `GET /api/ready` | Readiness. Checks the database and reports Test Mode |
| Worker `GET /health` | Liveness |
| Worker `GET /ready` | Readiness, plus in-flight count, processed, failed, and last success time |

Both deploy gates are liveness, deliberately. A readiness gate makes a first
deployment depend on start-up order — the worker would fail its own deploy
while waiting for a database that is still coming up.

The worker's `/ready` is the one to alert on: a rising `failed` with a stale
`lastSuccessAt` means it is running but not draining work.

## "Healthcheck failed"

Railway reports every start-up problem this way, and it is almost always the
wrong description. `/api/health` returns 200 without touching the database, so
if the health check cannot reach it, nothing is listening — the process exited
before it got that far.

**Read the Deploy Logs, not the Build Logs.** The build succeeding and the
image pushing tells you nothing about why the container stopped. The start
scripts print the reason there.

Ranked by how often it is the cause:

| Cause | What you will see in the deploy log |
| --- | --- |
| `DATABASE_URL` never added | `FATAL: DATABASE_URL is not set` |
| `DATABASE_URL` added as a reference that did not resolve | `FATAL: DATABASE_URL is set but empty` |
| `SERVICE_ROLE` missing on the worker | `NOTE: SERVICE_ROLE is not set; starting as the web service` |
| Migrations cannot reach the database | `FATAL: database migrations failed; the web server was not started` |
| A required variable missing — `ENCRYPTION_KEY`, `SESSION_SECRET`, Entra in production | `Invalid environment configuration:` and the failing key |
| Health check pointed at the wrong port | The server logs `Ready`, and the probe still fails |

### A reference that resolves to nothing

`DATABASE_URL` showing as `<empty string>` in the Railway variable editor means
the reference was stored but never resolved. Pasting `${{Postgres.DATABASE_URL}}`
as text into the raw editor does not reliably create a reference — add it with
the variable picker (**New Variable → Add Reference**, or the **Variable
Reference** link on the database's own Variables tab), which resolves it against
a service that actually exists.

Copying the connection string from the database's Variables tab works too, and
is the quickest way to get moving. It is a literal, so it goes stale if the
database is ever recreated; swap it for a reference once the deployment is up.

## Deploying

1. **Add the Postgres database first.** Both application services fail to start
   without it, and the failure is reported as a health-check failure.
2. Create the **web** service from this repository. Railway picks up
   `railway.json`. Set its variables, generate a public domain.
3. Create the **worker** service from the same repository. Set the same
   variables plus `SERVICE_ROLE=worker`. No public domain, no start command
   override, no config-file override.
4. Push. Railway builds one image for both.
5. Each service checks its configuration, then the web service migrates. Both
   print what they are doing in the **Deploy Logs**.
6. `GET /api/ready` — confirm `testMode: true` on a first deployment.
7. Sign in via Entra ID as a `BOOTSTRAP_ADMIN_EMAILS` address.
8. Under Settings, configure the directory role mapping, then clear
   `BOOTSTRAP_ADMIN_EMAILS`.
9. Configure integrations against **sandbox** credentials and health check.
10. Exercise a full engagement in Test Mode.
11. Only then: turn Test Mode off, and arm production sending in Settings.

### Variables Railway can fill in for you

Use references rather than pasted literals — a reference follows the service it
points at, a literal goes stale the next time that service is redeployed.

```
DATABASE_URL        = ${{Postgres.DATABASE_URL}}
APP_BASE_URL        = https://${{RAILWAY_PUBLIC_DOMAIN}}
ENTRA_REDIRECT_URI  = https://${{RAILWAY_PUBLIC_DOMAIN}}/api/auth/entra/callback
```

The worker has no public domain, so give it the web service's:
`APP_BASE_URL = https://${{@element/web.RAILWAY_PUBLIC_DOMAIN}}`. It is used for
the deep links written into Karbon, which must point at the web service.

### `SERVICE_ROLE` on the worker

The one variable that distinguishes the two services. Miss it and the worker
runs the web service's start command: it will try to migrate, and if it gets
that far it will serve the application instead of draining the queue. Both
services would then be web services and no job would ever run.

### A stray `.env` overrides the platform

Prisma Client loads a `.env` from the project root when it is imported, and
those values land in `process.env` before the environment schema reads them. A
`.env` copied into an image would therefore silently override the variables set
in Railway. `.dockerignore` excludes it for exactly this reason; do not add an
exception.

## Backups

Enable the Railway Postgres automated backups, and take one before any
migration that drops or rewrites a column.

```bash
pg_dump "$DATABASE_URL" --format=custom --file=element-$(date +%F).dump
pg_restore --clean --if-exists --dbname "$DATABASE_URL" element-2026-08-04.dump
```

The document volume does **not** need backing up. It holds only working copies;
Karbon is the system of record.

What matters in a restore is the audit trail, approvals and workflow state.
Regenerating a document is cheap; reconstructing who approved what is not.

## Rollback

**Application:** redeploy the previous deployment from the Railway UI. The
image is immutable, so this is exact.

**Database:** Prisma migrations are forward-only. Before a risky migration,
take a backup; to roll back, restore it and redeploy the matching image. Do not
hand-edit `_prisma_migrations`.

**A template:** never roll back by editing a published version — the database
forbids it. Re-activate the prior `TemplateVersion` on the Templates screen.
Documents already generated keep their own version reference, so history stays
truthful.

**Sequencing:** deploy the worker first when a change adds a job type, so no
job is claimed by a worker that cannot handle it. An unknown job type is
dead-lettered with a clear message rather than lost, and can be retried after
the worker catches up.

## Scaling

Both services scale horizontally. `SELECT … FOR UPDATE SKIP LOCKED` means
concurrent workers take different jobs. `WORKER_CONCURRENCY` (default 4) bounds
in-flight jobs per worker; LibreOffice conversion is the memory-hungry step, so
raise replicas before raising concurrency.
