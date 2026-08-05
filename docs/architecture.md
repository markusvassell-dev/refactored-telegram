# Architecture

## Paged lists

Every list that can outgrow a screen states what it is showing out of what there
is, and offers a way to the rest. A list that stops at a fixed number and says
nothing leaves a reader unable to tell a short answer from a truncated one; on
the audit log that ambiguity is the difference between a record and a suggestion.

Two properties carry the weight, and neither is automatic:

**The sort must be total.** `ORDER BY created_at DESC` is not a defined order
when timestamps tie, and SQL may return tied rows in a different sequence for
each query — so `OFFSET` over them drops some rows and repeats others. Ties are
guaranteed here rather than unlucky: Postgres `now()` is the transaction
timestamp, so every audit event written by one bulk rollout shares a `createdAt`
to the microsecond. Measured on 300 such events, paging at 20 a page lost 6 and
showed 6 twice. `withStableOrder` appends the primary key to every paged query,
which makes the order total and the paging sound.

**The count must not cost more than the answer.** An exact `COUNT(*)` over an
append-only audit table grows without bound, and nobody needs to know there are
exactly 41,882 events. Counting stops at 10,000 and reports a lower bound beyond
it — cheap, and true.

The page itself fetches one row more than it shows. That extra row is how a page
knows there is a next one without a second query, and it stays correct when the
total is only a lower bound.

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
  │                        is left, and only when explicitly enabled;
  │                        prior-year checkbox states read as suggestions.
  │                        Reads either a Karbon download or a file attached
  │                        by hand — same checks, same evidence, either way
  ▼
PREPARE_ENGAGEMENT
  │  records current Karbon information as its own source
  │  raises a FieldConflict wherever sources disagree — never chooses
  │  seeds one ServiceSelection per template checkbox, unconfirmed
  │  calculates every fee from the resolved price rule
  │  evaluates the date rules, blocking any deadline whose inputs
  │    are unknown rather than assuming the common case
  ├─ conflicts · blocked fees · blocked deadlines ──► a person decides
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

## Bulk rollout

The annual rollout is queued in two stages, and the split is the whole point.

```
selection form ──► BULK_ROLLOUT_ITEM ──► GENERATE_ENGAGEMENT_LETTER
                   key: batch + client       key: client + type + year + doc
                   + year + document         (deterministic)
```

The batch key stops a double-submitted preview queueing the same work twice.
The generation key stops a *different* batch covering the same engagement from
producing a second draft. Neither alone is enough: a fresh preview mints a new
batch id, so cross-batch protection has to come from a key that does not
mention the batch.

Every selected engagement is re-evaluated against the same readiness rule the
preview displayed, so a blocked row cannot be generated by editing a disabled
checkbox. A dry run answers the same question and queues nothing.

Nothing in a rollout reaches Adobe Sign. Each draft goes through individual
review and approval like any other.

## Which value is effective

A token routinely carries several rows: what Karbon says, what last year's letter
said, what a reviewer typed. One rule decides which is used, in
`resolveFieldValue`, and both the review UI and generation call it — so the
document gets exactly what the reviewer was looking at.

1. An explicit override, which carries a written reason.
2. The decision recorded against a resolved conflict.
3. A value a person typed and confirmed.
4. Otherwise the highest-priority source, which is what reconciliation
   recommends when it raises the conflict in the first place.

Ties break on source priority and then on the value itself, so the outcome never
depends on the order rows came back from the database.

A resolved conflict covers the values it was decided about. If a source later
changes, preparation re-opens it rather than applying a stale answer.

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

## Editable rules

Date rules are configuration, not code, and the editor computes its preview with
`evaluateDateRule` — the same function the worker calls. A preview that used a
separate implementation could disagree with what the application then produces,
which for a legal deadline is the whole risk.

Two boundaries are deliberate. A rule's `requiredFacts` and its branch
conditions are not editable, because a fact needs a matching question in the
catalogue for a reviewer to answer; inventing a fact name would create a deadline
nothing could unblock. And a change never rewrites a date a reviewer confirmed —
the impact is counted and stated before saving, and the new rule governs only
what has not been decided yet.

## Deliberate decisions

**Prisma errors are matched by code, not by `instanceof`.** Next bundles server
code in layers and the generated Prisma runtime can be loaded more than once in
one process, so `instanceof PrismaClientKnownRequestError` returns false for a
genuine Prisma error raised through the other copy. Every handled unique
constraint — a duplicate engagement, a raced enqueue, a repeated webhook — then
becomes an unhandled failure in the web app while passing in tests. The error
code is part of Prisma's documented contract; `isUniqueConstraintError` in
`@element/database` matches on that instead.

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
