# Railway deployment

## Services

Three, from one repository:

| Service | Start command | Health check | Notes |
| --- | --- | --- | --- |
| **web** | `pnpm db:migrate && pnpm --filter @element/web start` | `GET /api/health` | Runs migrations on boot; safe to run concurrently, Prisma takes an advisory lock |
| **worker** | `pnpm --filter @element/worker start` | `GET /ready` on `WORKER_HEALTH_PORT` | Needs LibreOffice, which the image provides |
| **PostgreSQL** | Railway plugin | — | Version 16 |

Both application services build from the same `Dockerfile`. Point the worker
service at `railway.worker.json`, or override its start command in the Railway
UI.

No other service is justified. The job queue is Postgres-backed, so there is no
broker to run.

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

### Safety switches

| Variable | Default | Notes |
| --- | --- | --- |
| `TEST_MODE` | `true` | A floor. While set, the database cannot turn Test Mode off |
| `ALLOW_PRODUCTION_SENDING` | `false` | Must be `true` **and** armed by an administrator in Settings |
| `DEV_LOGIN_ENABLED` | `false` | The app refuses to boot with this set outside development |

Deploy first with the defaults. Verify. Only then turn Test Mode off and arm
sending.

### Integrations

`KARBON_API_BASE_URL`, `KARBON_BEARER_TOKEN`, `KARBON_ACCESS_KEY`,
`KARBON_WEBHOOK_SECRET`, `ADOBE_SIGN_API_BASE_URL`, `ADOBE_SIGN_CLIENT_ID`,
`ADOBE_SIGN_CLIENT_SECRET`, `ADOBE_SIGN_REDIRECT_URI`,
`ADOBE_SIGN_REFRESH_TOKEN`, `ADOBE_SIGN_WEBHOOK_SECRET`.

Credentials can be entered on the Integrations screen instead, where they are
stored encrypted. That is preferable — it keeps them out of the platform
environment and makes rotation auditable.

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

The worker's `/ready` is the one to alert on: a rising `failed` with a stale
`lastSuccessAt` means it is running but not draining work.

## Deploying

1. Push. Railway builds the Docker image.
2. The web service runs migrations, then starts.
3. Wait for both health checks.
4. `GET /api/ready` — confirm `testMode: true` on a first deployment.
5. Sign in via Entra ID.
6. Configure integrations against **sandbox** credentials and health check.
7. Exercise a full engagement in Test Mode.
8. Only then: turn Test Mode off, and arm production sending in Settings.

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
