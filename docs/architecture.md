# Architecture

## Shape

A pnpm monorepo. Two runnable applications share one set of domain packages, so
the web request path and the background worker execute identical business
logic.

```
apps/
  web/          Next.js 15 App Router — pages, server actions, route handlers
  worker/       Long-running job runner with health endpoints

packages/
  shared/       Environment contract, errors, redaction, crypto, money,
                permissions, idempotency keys, file naming
  database/     Prisma schema, migrations, generated client, seed
  workflows/    Engagement state machine and the business gates
  pricing/      Decimal fee engine and rule precedence
  dates/        Configurable deadline rule engine
  audit/        Append-only audit logger
  documents/    template-engine, docx-renderer, pdf-renderer, comparison,
                sanitation, plus low-level ooxml helpers
  integrations/ karbon, adobe-sign, identity, extraction
  services/     Application services used by both apps
  ui/           Shared React primitives

templates/
  source/       The approved .docx files, read-only, hashes recorded
  normalized/   Tokenised copies the renderer actually uses
  manifests/    Field, section, checkbox, anchor and sanitation contracts
  test-fixtures/
```

The specification suggested `packages/integrations/karbon` and
`packages/documents/template-engine` as separate workspace packages. They are
directories inside two packages instead, with subpath exports
(`@element/documents/template-engine`). The layout and boundaries are the same;
the build is materially simpler.

Workspace packages ship TypeScript source rather than build output. Next.js
compiles them via `transpilePackages`, the worker runs them through `tsx`, and
Vitest resolves them directly. One `tsc --noEmit` typechecks everything.

## Data flow

### Engagement letter

```
Trigger (individual · bulk · configured Karbon status)
  │  deterministic idempotency key — a duplicate is a no-op
  ▼
LOCATE_PRIOR_YEAR_DOCUMENTS
  │  searches the current work item, then prior-year work items, then the
  │  client document area; scores each candidate on its contents
  ├─ ambiguous ──► SOURCE_DOCUMENT_REVIEW_REQUIRED   (a person chooses)
  ▼
EXTRACT_DOCUMENT_TEXT      deterministic patterns first; AI only for what
  │                        is left, and only when explicitly enabled
  ▼
Pricing · Dates · Services      each value keeps its source and evidence
  │
  ▼
GENERATE_ENGAGEMENT_LETTER
  │  approved master template + confirmed values
  │  conditional sections removed · internal content removed · highlights
  │  stripped · checkboxes toggled · validated · converted to PDF
  ▼
UPLOAD_TO_KARBON           draft .docx and .pdf, review task, review note
  ▼
REVIEW_REQUIRED → IN_REVIEW → APPROVED → READY_TO_SEND
  │  approval is explicit, records the file hash, and cannot be self-granted
  ▼
CREATE_ADOBE_AGREEMENT     one agreement per approved version and attempt
  ▼
webhook / reconciliation poll → PARTIALLY_SIGNED → SIGNED
  ▼
RETRIEVE_SIGNED_DOCUMENTS  signed PDF + signing certificate back to Karbon,
                           never overwriting anything that already exists
  ▼
COMPLETE
```

### Completion cover letter

Generation requires **all three** conditions: every required final source
document present and selected, the designated internal approval complete, and
the engagement in `READY_FOR_COVER_LETTER`. A PDF appearing in Karbon is never
sufficient on its own.

The enclosure list is built from documents that are actually present. If a
selected source document later changes, its fingerprint changes, the package is
marked `STALE`, delivery is refused, and a new approval is required.

## Provider interfaces

Every external dependency sits behind an interface, so the real client, the
Test Mode adapter and a test double are interchangeable.

| Interface | Real | Test Mode / tests |
| --- | --- | --- |
| `KarbonProvider` | `KarbonRestClient` | `MockKarbonProvider`, `BlockedKarbonProvider` |
| `AdobeSignProvider` | `AdobeSignRestClient` | `MockAdobeSignProvider`, `BlockedAdobeSignProvider` |
| `PdfConverter` | `libreOfficeConverter` | injectable fake |
| `FieldExtractor` | `DeterministicExtractor`, `AiExtractor` | injectable |
| `IdentityProvider` | `EntraIdProvider` | `DevelopmentIdentityProvider` |
| `AuditLogger` | Prisma-backed | injectable |
| `JobQueue` | Postgres `SKIP LOCKED` | same, against the test database |

`resolveProviders()` decides which to hand out. When Test Mode is on and no
sandbox connection is configured it returns a *blocked* adapter — a production
write is impossible by construction rather than by convention. Every provider
reports `isMock`, and the Integrations screen shows it.

## Web and worker responsibilities

**Web** handles authentication, authorisation, rendering, and short operations.
It enqueues anything slow. Route handlers and server actions translate between
HTTP and the service layer; they contain no business rules.

**Worker** runs everything long or retryable: Karbon synchronisation, document
location and extraction, rendering, PDF conversion, uploads, Adobe agreement
creation and status reconciliation, cover-letter generation, stale detection,
bulk rollout, and temporary-file purging. It also reclaims jobs abandoned by a
crashed worker and drains in-flight work on shutdown.

Both processes can run several replicas. `SELECT … FOR UPDATE SKIP LOCKED`
means concurrent workers take different jobs rather than colliding.

## Security boundaries

1. **Session** — encrypted, authenticated cookie holding only a user id and
   expiry. Roles are re-read from the database on every request, so revoking a
   role takes effect immediately.
2. **Authorisation** — every server action and page calls `requirePermission`.
   Separation of duties is enforced separately: nobody approves their own
   draft, wording change, or fee override.
3. **CSRF** — a token bound to the session, checked by every mutating action.
4. **Documents** — served only through short-lived signed links, verified
   independently of the session, with path traversal blocked and file contents
   checked against their declared type.
5. **Webhooks** — verified before they are trusted, and de-duplicated by
   provider event id using a unique constraint.
6. **Database** — the last line. Illegal transitions, audit mutation, changes
   to published templates or approved documents, incorrectly rounded fees and
   duplicate live agreements are all rejected by the database itself.
7. **Logs** — redacted at the logger. Secrets are dropped, client identifiers
   masked, and no document body is ever written to a log.

## Deliberate decisions

**OOXML surgery, not DOM round-tripping.** Re-serialising WordprocessingML is
the standard way to lose numbering, headers, footers and content controls. The
renderer splices text runs and deletes whole block ranges, so anything it does
not touch is preserved byte-for-byte. The tests assert the logo, styles,
numbering and footer parts are identical to the source.

**`[[token]]`, not `{{token}}`.** Double curly braces are Adobe Sign's text-tag
syntax. Using a different delimiter means the two can never collide.

**Postgres for the queue.** The database is already a hard dependency, and job
state belongs in the same transaction boundary as the workflow it drives.
Adding a broker would add an operational dependency for no correctness gain.

**The state machine is one source of truth.** It is defined in TypeScript and
seeded into a `workflow_transition` table that a trigger enforces. A test fails
if the two ever drift.
