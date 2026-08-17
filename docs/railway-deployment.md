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
| `ENTRA_TENANT_ID`, `ENTRA_CLIENT_ID`, `ENTRA_CLIENT_SECRET` | Required outside development — the app refuses to boot without them, or with values of the wrong shape; see below |
| `ENTRA_REDIRECT_URI` | `https://<your-domain>/api/auth/entra/callback`, registered identically in Entra |
| `BOOTSTRAP_ADMIN_EMAILS` | The first administrator. Required on a first deployment; see below |
| `ENTRA_SIGN_IN_HOSTS` | Only for a national cloud. Defaults to `https://login.microsoftonline.com`, which the Content Security Policy must name for sign-in to be able to redirect there |

#### Where the three Entra values come from

One app registration in the Azure portal, under **Entra ID → App
registrations → New registration**:

| Variable | Where | Shape |
| --- | --- | --- |
| `ENTRA_TENANT_ID` | Overview → **Directory (tenant) ID** | A GUID, or a verified domain such as `contoso.onmicrosoft.com` |
| `ENTRA_CLIENT_ID` | Overview → **Application (client) ID** | Always a GUID |
| `ENTRA_CLIENT_SECRET` | Certificates & secrets → New client secret → the **Value** column | An opaque string, shown once |

Two things reliably go wrong here. The portal shows a client secret's **Value**
and its **Secret ID** side by side and the Secret ID is the one that looks like
an identifier — copy the Value, and copy it immediately, because it is masked
after you leave the page. And the redirect URI must be registered under
**Authentication → Add a platform → Web** exactly as `ENTRA_REDIRECT_URI` is
set, character for character; a trailing slash is a different URI.

Grant delegated `openid`, `profile`, `email` and `User.Read`, then grant admin
consent so nobody is asked to consent individually.

##### `AADSTS900023`, and why the app now refuses to boot instead

> Specified tenant identifier '…' is neither a valid DNS name, nor a valid
> external domain.

This is Microsoft saying `ENTRA_TENANT_ID` is not a directory identifier —
almost always a placeholder that was never replaced. It used to be discovered
by a person clicking "Continue with Microsoft" on an apparently healthy
deployment, because a placeholder is a perfectly good non-empty string and the
old check only asked whether the variable was set.

The environment schema now checks the *shape* of all three values, so in
staging and production a placeholder fails the deploy with the variable named,
and the sign-in button is disabled with the reason on the page rather than
offered and broken. The check cannot tell whether a well-formed GUID is real —
only Microsoft can — so `AADSTS700016` (application not found in directory)
still means what it always did.

#### The first administrator

Signing in proves who you are and grants nothing, so the first person to sign in
gets a user record and no roles — and granting a role requires an administrator
who does not exist yet. `BOOTSTRAP_ADMIN_EMAILS` breaks that deadlock: a listed
address is granted `ADMINISTRATOR` **after** Entra ID authenticates it, never
before, and the grant is written to the audit trail as `ROLE_GRANTED`.

Sign in once, grant the other administrators their roles on the Users page, then
clear the variable.

If the address does not match, the result is a dead end that cannot be escaped
from inside the application: you are signed in, you hold no roles, every screen
that matters is read-only, and granting a role needs an administrator who does
not exist. `pnpm admin:grant you@yourfirm.ca ADMINISTRATOR` in the deployment's console
is the way out. It needs shell access to the deployment, which is already the
most privileged thing a person can have here, and it is audited.

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
`KARBON_NOTE_AUTHOR_EMAIL`, `ADOBE_SIGN_API_BASE_URL` (region-specific),
`ADOBE_SIGN_REDIRECT_URI`, and the two webhook secrets —
`KARBON_WEBHOOK_SECRET` and `ADOBE_SIGN_WEBHOOK_SECRET` — which are values this
application chooses and gives to the vendor, not credentials the vendor issues.

Set `KARBON_NOTE_AUTHOR_EMAIL` to a current user at the firm. Karbon requires
every note to name an author; left unset, notes in clients' timelines are
attributed to whichever user the tenant lists first, which may be someone who
has left.

See the full list in `.env.example`.

## Database

```bash
pnpm db:migrate      # prisma migrate deploy
pnpm db:seed         # idempotent; safe to re-run
```

**The web service runs both on every boot.** A migrated schema is not a usable
application: the seed is what registers the approved templates, the default
price and date rules, and the system settings. Left as a manual step it was
simply never run, and the deployment came up with every screen rendering, no
document generatable, and the Templates page reporting all eight document types
as awaiting a template that was in the image the whole time.

The seed upserts, and skips a template version that already exists rather than
rewriting it — which the database forbids in any case. Sample clients and the
sample engagement are skipped when `APP_ENV=production`.

If it fails the deploy fails, for the same reason a failed migration does:
starting anyway would hide a half-configured application behind screens that
render but cannot do any work.

Run `pnpm templates:normalize` **before** building if any template changed; the
normalised files are committed, so a normal deploy does not need it.

## Volumes

**Not required.** Working documents live in Postgres, not on the filesystem.

They used to live on disk, which is correct on one machine and quietly wrong
here: the web and the worker are separate services, and Railway attaches a
volume to exactly one service. A volume on each is two separate disks, so the
web would upload a source document the worker could not read, and the worker
would generate a PDF the web could not serve. No volume configuration fixes
that; only shared storage does, and Postgres is the store both services already
have.

Sizing instead applies to the database: roughly 2 MB per live engagement of
working copies, cleared by the purge job on the retention schedule.

A volume is still worth attaching if a deployment predates this change and has
documents on disk that should stay readable — reads fall back to the filesystem
when a reference has no row.

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

## Which build is deployed

`GET /api/health` names the commit answering the request:

```json
{ "status": "ok", "service": "web",
  "build": { "commit": "a35d3d9", "branch": "claude/…", "deploymentId": "…" } }
```

Compare it against `git log --oneline -1`. If they differ, the deployment has
not picked up the branch yet, and anything you observe against that container is
a fact about old code.

`pnpm verify:karbon` prints the same line first, for the same reason: a run once
reported three failures that were already fixed and pushed, and nothing in its
output distinguished "Karbon rejects this" from "this container is a week old".

`commit` reads `RAILWAY_GIT_COMMIT_SHA`, which Railway injects on every deploy
from a connected repository. Anywhere it is not set, the field is `null` — the
endpoint reports what it knows and never guesses a version.

**Redeploying is done in Railway, not from the repository.** Pushing to the
deploy branch triggers a build only when the service is connected to that branch
with automatic deploys on. Otherwise open the service, then **Deployments →
Deploy** (or **Redeploy** on the latest).

One trap: an SSH session opened from the Railway console stays attached to the
container it connected to. After a redeploy that container is the *old* one.
Close the shell and open a new one, then check `build` before trusting anything
it tells you.

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
| `DATABASE_URL` resolving to a *different* database | `The table 'public.user' does not exist in the current database` (Prisma `P2021`) — see below |
| `SERVICE_ROLE` missing on the worker | `NOTE: SERVICE_ROLE is not set; starting as the web service` |
| Migrations cannot reach the database | `FATAL: database migrations failed; the web server was not started` |
| A required variable missing or malformed — `ENCRYPTION_KEY`, `SESSION_SECRET`, Entra in production | `Invalid environment configuration:` and the failing key |
| An Entra value left as a placeholder | `Invalid environment configuration:` … `is not a directory id` |
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

### A reference that resolves to the wrong database

This is the one that is easy to miss, because nothing fails at start-up. The
service connects, authenticates, and then every query fails with `P2021` —
`The table 'public.user' does not exist in the current database`.

It means the two services are not sharing a database. The web service applies
migrations and the worker deliberately never does, so the worker sees an empty
database and can claim no jobs at all: no generation, no filing into Karbon, no
cover letters. The worker stays up and its liveness check passes throughout,
which is why this can sit unnoticed.

**The fix is to make the worker's `DATABASE_URL` identical to the web
service's**, character for character. Read the web service's value in the raw
variable editor and compare — the difference is usually one of:

- two Postgres services in the project, with one service on each;
- the same server but a different database name at the end of the path;
- a different `?schema=` parameter.

Do not retype it from memory, and do not assume the reference names match: a
reference to a Postgres service that exists but is not the one holding the
schema resolves perfectly and is still wrong.

Afterwards, the worker's `/ready` is the check that it took: `processed` should
climb and `lastSuccessAt` should be recent. Liveness passing proves nothing
here — it passed the whole time it was pointed at the wrong database.

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
7. Sign in via Entra ID as a `BOOTSTRAP_ADMIN_EMAILS` address. If the header
   reads **no roles assigned**, the address Entra authenticated is not the one
   in the variable — the two must match exactly, ignoring case. Either correct
   the variable and sign in again, or grant the role from the console:

   ```bash
   pnpm admin:users                                # who exists, and what they hold
   pnpm admin:grant you@yourfirm.ca ADMINISTRATOR  # grant
   ```

   `admin:users` also settles what the address actually is, which nothing in
   the application displays. Every console grant is audited as `ROLE_GRANTED`
   with `grantedBy: 'console'`, so it is distinguishable from one made by an
   administrator in the application.
8. Grant the other staff their roles on the **Users** page — everyone signs in
   once and arrives with none — then clear `BOOTSTRAP_ADMIN_EMAILS` once a
   second administrator exists.

   Roles are **not** taken from Entra. Directory groups and app roles are
   recorded from the token and deliberately not acted on; the setting that once
   claimed to map them granted nothing, because nothing could write it. See
   `docs/entra-setup.md`.
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

### Watch patterns must include the shared packages

Each service has build **watch patterns** deciding which changed paths trigger a
rebuild. They were `/apps/web/**` and `/apps/worker/**` — each service watching
only its own folder.

**That is wrong in this repository, and it was silently wrong for an evening.**
Both services run the shared workspace packages: the worker's jobs are almost
entirely `@element/services` and `@element/integrations`. A change confined to
`packages/` triggered neither rebuild, so a service kept running the version of
the shared code it happened to be built with.

Observed rather than theorised. Three commits reached `main` between 21:33 and
22:17 on 14 August 2026, all touching `packages/`, none touching
`apps/worker/**`; the worker's latest deployment stayed the one from 21:05.
Nothing failed. The web service looked current because those commits happened
to touch `apps/web/` too.

The failure this invites is the worst-shaped one available here: a fix to the
signing return leg or to Karbon filing lives in `packages/services`, ships,
reads as deployed, and the worker — the only thing that runs those jobs — never
receives it.

Both services now watch:

```
/apps/<own app>/**
/packages/**
/package.json
/pnpm-lock.yaml
/pnpm-workspace.yaml
```

A docs-only or CI-only commit still rebuilds nothing, which is the point of
keeping patterns at all.

**A watch pattern change applies to the next trigger, not retroactively.** A
service already behind stays behind until something it now watches changes; to
pull it forward immediately, use **Deploy** on the service in Railway, which
builds from the branch head. Railway's *Redeploy* re-runs the existing build and
will not pick up new code.

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

The database backup now covers working copies as well as workflow state. There
is no document volume to back up separately; it holds only working copies;
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
