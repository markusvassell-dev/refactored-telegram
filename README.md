# Element Engagements

Manages the annual rollout, review, approval, signing and storage of engagement
letters and completion cover letters for an accounting firm, integrated with
Karbon and Adobe Acrobat Sign.

Karbon remains the primary document system of record. This application holds
metadata, workflow state, extraction evidence, approvals and audit history —
never the permanent copy of a client's tax file.

The displayed product name is configurable (`APP_NAME`, or the `product_name`
system setting). No application logic depends on it.

---

## What it does

1. Finds the client and the Karbon work item.
2. Locates and verifies the prior-year engagement letter — by its contents, not
   its filename.
3. Uses the **current approved master template** as the only source of legal
   wording.
4. Extracts client-specific information from the prior-year letter, with
   evidence and a page citation for every value.
5. Compares that against current Karbon information and asks a person to
   resolve any conflict.
6. Rolls the engagement forward, calculates the fee, and generates a Word
   document and a PDF.
7. Uploads the draft to Karbon and raises a review notification.
8. Requires explicit internal approval before anything is sent.
9. Sends through Adobe Acrobat Sign, tracks signing, and returns the signed PDF
   and the signing certificate to Karbon.
10. Later, generates the completion cover letter, which a person must review and
    approve before it is marked ready for delivery.

## Supported document types

| Document | Status |
| --- | --- |
| T1 joint taxpayer engagement letter | Available — approved template supplied |
| T2 corporate engagement letter | Available — approved template supplied |
| T3 trust and estate engagement letter | Available — approved template supplied |
| T1 personal completion cover letter | Available — approved template supplied |
| Compilation engagement completion cover letter | Available — approved template supplied |
| T1 **single**-taxpayer engagement letter | **Unavailable** — no approved template |
| T2 completion cover letter (non-compilation) | **Unavailable** — no approved template |
| T3 completion cover letter | **Unavailable** — no approved template |

The data model, workflow and pricing support all eight. The three without an
approved template are registered and visible on the Templates screen as
*awaiting an approved template*, and generation for them is refused. The
application does not invent legal wording, and a T2 without a compilation will
**not** borrow the compilation cover letter — that path is blocked with an
explanation.

## Local setup

Requirements: Node 22, pnpm 9, PostgreSQL 16, and LibreOffice **Writer**
(`libreoffice-writer`, not just `libreoffice-core` — core alone cannot load
.docx and PDF conversion will fail).

```bash
pnpm install
cp .env.example .env          # then fill in ENCRYPTION_KEY and SESSION_SECRET
openssl rand -hex 32          # generate each of them

createdb element_engagements
pnpm db:generate
pnpm db:migrate
pnpm templates:normalize      # rewrites the approved templates into tokens
pnpm db:seed

pnpm dev                      # web,   http://localhost:3000
pnpm dev:worker               # worker, health on :3001
```

Or with Docker, which mirrors the Railway topology:

```bash
docker compose up --build
```

Sign in with the development login (available only when `APP_ENV` is
`development` or `test`) as any of the seeded roles.

## Test Mode

Test Mode defaults to **on**, so a fresh or misconfigured deployment fails safe.
While it is on:

- no real client is emailed;
- no production Adobe Sign agreement is created;
- nothing is written to a production Karbon work item or status;
- every generated file is prefixed `TEST`;
- a permanent banner appears on every page;
- integrations are mock or blocked adapters, and the Integrations screen says
  which.

Turning it off is an administrator action. Production sending must then be
armed **separately**, and `TEST_MODE` in the environment is a floor the
application cannot override.

## Running tests

```bash
pnpm typecheck
pnpm lint
pnpm test              # unit + integration
pnpm test:unit         # no external dependencies
pnpm test:integration  # needs Postgres and LibreOffice
pnpm test:e2e          # needs a browser; see docs/testing.md
pnpm build
```

## Railway deployment

Two services from one image, plus PostgreSQL. See
[docs/railway-deployment.md](docs/railway-deployment.md).

## Integration setup

- [docs/karbon-capability-matrix.md](docs/karbon-capability-matrix.md) — what
  the Karbon API can and cannot do here, and the fallback for each gap.
- [docs/adobe-sign-setup.md](docs/adobe-sign-setup.md) — app registration,
  OAuth, webhooks, text tags, and production activation.

**Both integrations are implemented against published documentation but have
not been exercised against a live tenant from this codebase.** Every capability
is reported as `unverified` on the Integrations screen until a health check
succeeds with real credentials. Nothing in this repository claims a vendor
integration works because the code compiles.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| PDF conversion fails with "source file could not be loaded" | `libreoffice-writer` is not installed. `libreoffice-core` alone cannot read .docx. |
| Buttons and tabs do nothing in development | A Content-Security-Policy without `'unsafe-eval'` blocks React Refresh. The config already relaxes this for development only. |
| "No approved master template" | That document type has no activated template. Upload and activate one on the Templates screen. |
| Generation blocked on "a confirmed fee is required" | No prior-year fee was found. Enter a base fee or select a rate card; the application will not guess or produce a zero-dollar fee. |
| Generation blocked on CSRS 4200 | A reviewer must confirm whether compilation services are included this year. The prior year's answer is only a suggestion. |
| "This working copy has passed its retention period" | Temporary files are purged after `DOCUMENT_RETENTION_HOURS`. Regenerate, or open the copy in Karbon. |
| Illegal status transition error | The workflow rejected a step, in the application and again in the database. See `packages/workflows`. |

## Documentation

| Document | Contents |
| --- | --- |
| [architecture.md](docs/architecture.md) | Components, data flow, provider interfaces, security boundaries |
| [implementation-plan.md](docs/implementation-plan.md) | Phases, what is built, what remains |
| [data-model.md](docs/data-model.md) | Entities, relationships, constraints, audit strategy |
| [template-system.md](docs/template-system.md) | Source handling, normalisation, manifests, validation, versioning |
| [karbon-capability-matrix.md](docs/karbon-capability-matrix.md) | Per-operation support, method, fallback, limitation |
| [adobe-sign-setup.md](docs/adobe-sign-setup.md) | Registration, OAuth, webhooks, anchors, activation |
| [railway-deployment.md](docs/railway-deployment.md) | Services, variables, migrations, health, backups, rollback |
| [security.md](docs/security.md) | Authentication, authorisation, secrets, logging, retention, AI |
| [operations-runbook.md](docs/operations-runbook.md) | Failure scenarios and recovery |
| [testing.md](docs/testing.md) | What is tested, how to run it, what is not covered |
