# Testing

```bash
pnpm typecheck          # tsc --noEmit across every package and app
pnpm lint               # eslint
pnpm test               # unit + integration  (314 tests)
pnpm test:unit          # 171 — no external dependencies
pnpm test:integration   # 143 — needs Postgres and LibreOffice Writer
pnpm test:e2e           # 25  — needs a browser
pnpm build              # production build
```

## Prerequisites

Unit tests need nothing. Integration and end-to-end tests need:

```bash
createdb element_engagements_test
export TEST_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/element_engagements_test?schema=public"
DATABASE_URL="$TEST_DATABASE_URL" pnpm db:migrate
DATABASE_URL="$TEST_DATABASE_URL" APP_ENV=test pnpm db:seed
```

LibreOffice **Writer** must be installed — `libreoffice-core` alone cannot load
`.docx`, and conversion fails with "source file could not be loaded".

If the environment supplies a preinstalled Chromium rather than letting
Playwright download one:

```bash
export PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome
```

`tests/setup.ts` supplies a complete fake environment, so no `.env` is needed
and Test Mode is forced on for the whole suite.

## Unit tests (171)

No database, no filesystem, no network.

**Pricing (29)** — the four price methods against the specification's own
examples; the round-up-to-$5 rule including $1,030 / $1,031 / $1,035 / $1,036;
that decimal arithmetic really is decimal (`0.1 + 0.2 === 0.3`); T2 and
compilation priced separately, with compilation marked not applicable rather
than zero; a missing prior-year fee blocking rather than guessing; approval
required for a decrease and for an increase above the threshold; rule
precedence across the five levels.

**Workflow (35)** — every status covered; `DRAFT_READY` cannot reach
`SENT_FOR_SIGNATURE` or `READY_TO_SEND`; `APPROVED` is reachable only from
`IN_REVIEW`; `NEEDS_ATTENTION` recovery cannot skip an approval; declined and
expired agreements are never auto-resent; the database seed matches the state
machine exactly; all five gates.

**Permissions (21)** — each role's boundaries; that an **administrator cannot
approve or send** client-facing documents; separation of duties; idempotency
key determinism and sensitivity; source fingerprint stability.

**Dates (17)** — month-end clamping (31 Aug + 6 months = 28 Feb); business days
skipping statutory holidays; T2 six-month filing and the two- versus
three-month balance-due day *blocked until eligibility is confirmed*; T1
30 April versus 15 June with the payment date unchanged; T3 90 days; a
malformed rule refusing to produce a date.

**Template engine (20)** — top-level block splitting without descending into
nested tables; replacement of a placeholder split across runs, preserving the
first run's formatting; several replacements in one paragraph; XML escaping;
curly-quote and dash tolerance; scoped normalisation; highlight stripping;
manifest validation.

**Prior-year checkboxes and date facts (9)** — a ticked and an unticked box read
from the same document; the glyph nearest the anchor winning; matching through
smart quotes and collapsed whitespace; and — the point of the suite — an anchor
that cannot be found, carries no glyph, or points at a token coming back as
`null` rather than `false`, because `false` would silently drop a service the
client actually bought. Every catalogued date fact has a question and an
explanation, and an uncatalogued one still produces something askable.

**Document verification (12)** — the check standing between a file named
`2025 Engagement Letter.docx` and last year's fee reaching a client. A genuine
letter is accepted confidently; a client name still matches through casing and
punctuation, and a business number however it is spaced. A document *marked* as
a draft is disqualified, but one that merely offers "a draft return or filing
summary for management review" — the approved template's own wording — is not.
A letter for the wrong year is disqualified. Another client's letter raises no
disqualifier at all and simply scores far below the threshold, which is why "no
disqualifiers" is not the same as "this is the right document". A filename never
carries a decision on its own.

**Signed download links (9)** — a reference survives a round trip through a URL
path segment; a signature cannot be moved onto another document, cannot have its
expiry extended, cannot be forged or malformed, does not survive a different
deployment secret, and stops verifying once it expires.

**Effective values and field validation (18)** — which of a token's several rows
reaches the client: an override first, then a resolved conflict, then a value
someone confirmed, then the highest-priority source — and, the point of the
suite, *the same answer whichever order the rows arrive in*, which is the defect
that made the outcome depend on Postgres. Plus every data type a reviewer can
type into: an email that is only nearly one, an incomplete telephone number,
February 31 rejected rather than silently shifted into March, money kept exact
and never negative, a four-digit year, yes/no stored as a boolean, and an enum
value matched case-insensitively against the permitted list.

## Integration tests (143)

Real Postgres, real document engine, real LibreOffice.

**Database guards (16)** — the seeded transitions match the state machine
exactly; illegal transitions rejected by trigger; audit events immutable
against both update and delete; the rounding rule rejected at the constraint
level; a second live agreement impossible; duplicate job keys and webhook event
ids rejected; published templates and approved documents immutable.

**Document rendering (19)** — T2 with CSRS 4200 keeps section 3A, the
compilation report and the particulars table; without it, all three are removed
entirely and the fee reads "Not applicable"; the internal checklist always
removed; every highlight stripped; the logo, styles, numbering and footer parts
**byte-identical** to the source; table count preserved; rendering
deterministic; Adobe tags only when sending; a supplied signature date never
written. All five approved templates render with zero unresolved tokens and
convert to a valid PDF within their expected page range.

**End-to-end workflow (19)** — full T2 with compilation from generation through
Karbon upload, review, approval, sending, signing and return; the review note
carrying the fee comparison and deep link; the TEST filename prefix; a preparer
refused approval of their own draft; a retry not creating a second agreement; a
missing prior-year fee blocking then unblocking; sending refused without
approval and refused in Test Mode without a sandbox; regeneration superseding
rather than overwriting; wording exceptions needing a reason and a second
approver; the three cover-letter trigger conditions; dynamic enclosures; a
non-compilation T2 refused the compilation template; staleness on a changed
source; human approval recording the file hash and source documents; duplicate
webhooks; joint T1 parallel signing.

**Preparation (19)** — current Karbon values recorded as their own source and
never overwriting a confirmed one; a disagreement raising a conflict that
recommends the higher-priority source instead of choosing; a cosmetic difference
treated as agreement; the same conflict not raised twice and a resolved one left
alone; fees taken from the prior-year letter, increased and rounded upward
($1,234 → $1,271.02 → $1,275), and blocked outright when no prior-year amount
was found; the compilation fee priced only when compilation is selected for the
new year; each date recording its rule, input and assumptions; the balance-due
day blocked until eligibility is answered, then two months for "no" and three
for "yes"; a confirmed date never rewritten; last year's ticks carried forward
as `priorYearSelected` with `confirmed` still false; three consecutive runs
producing exactly the same row counts; and a resolved conflict re-opened once a
source changes, because a decision only covers the values it was made about.

**Editing a date rule (12)** — a date rule is the firm's interpretation of a
statutory deadline, so these are about restraint and traceability. A change
carries a written reason and records the whole definition on both sides, so a
previous interpretation can be reconstructed. A definition that does not parse
is refused with what is wrong and the stored rule is left untouched; so is a
rule with no steps, which would return its own starting date. The saved rule is
then re-evaluated to confirm it really produces the new deadline. A stored
definition that has gone bad is reported rather than silently producing nothing.
And the impact is counted before the change: unconfirmed dates will be
recalculated, dates a reviewer already confirmed are left exactly as they were —
asserted by reading the row back after an edit.

**Attaching a source document (10)** — an uploaded file goes through the same
checks as one Karbon located: bytes that are not the type they claim to be are
refused outright, an unaccepted type is refused, and an empty file is refused.
A genuine prior-year letter is stored, scored, confirmed, and its signals kept
so a reviewer can see why. Another client's letter is stored *unconfirmed* —
picking a file is not evidence about what is in it. The same file twice reports
rather than creating a second candidate; a different file becomes a new one. A
trial balance is stored without being scored as though it were an engagement
letter.

**Starting an engagement (18)** — what it refuses is the point, because each of
these is easy to create by accident and awkward to unpick. A type with no
approved template could never produce a document; a corporate engagement without
its year-end could never have a filing deadline; February 31 and a tax year of
9999 are refused rather than stored; a second engagement for the same client,
type and year names the one that already exists; a new client whose name already
exists is refused rather than splitting one firm across two records. What it
does automatically is narrow and checked: the prior year is linked when it
exists, a Karbon work item is linked only when this application already knows
it, and a T1 is calendar-year so a supplied year-end is not recorded.

**Bulk rollout (11)** — the annual rollout is the only action that touches many
clients at once, so these are about restraint. A role without `generation:start`
is refused. A blocked engagement is refused *even when its id is submitted* — a
disabled checkbox is a courtesy, the re-evaluation is the control — and the ready
ones in the same batch still go through, with the refusals named. Work is queued
as a `BULK_ROLLOUT_ITEM`, which is what lets a second rollout of the same
engagement resolve to the one generation key rather than a second draft;
submitting the same preview twice is a no-op. A dry run reports what would
happen, counts work already queued as already queued, writes nothing to the
queue and nothing to the audit trail.

**Field editor (17)** — the form is built from the approved template's own field
definitions: every field labelled and typed, carrying the bracketed placeholder
it fills in the letter, grouped with the client first. The CSRS 4200 fields are
mandatory only when compilation is selected, so required-ness matches the
generation gate exactly. A value shows its source, confidence and evidence; a
token whose sources still disagree is flagged. A calculated deadline and a
calculated fee are read-only and a value typed into either is refused rather
than stored where generation would discard it, as is a token the template does
not declare. Saving confirms the value, writes its typed column as well as its
text, records the edit without copying the value into the audit trail, reports
an unchanged value instead of rewriting it, and treats an emptied box as
clearing the value rather than storing `""`.

## Browser tests (25)

Playwright, Test Mode on.

Anonymous access refused **server-side**; the development login offered only in
a test environment; the Test Mode banner on every page; integrations reported
honestly as mocks with the capability matrix showing unverified and unsupported
levels; production sending un-armable while the environment sets `TEST_MODE`;
unsupplied templates shown as awaiting approval; a read-only user refused the
audit log; skip link, landmarks and ARIA tab wiring; health and readiness
endpoints; webhook signature rejection and the Adobe verification handshake.

Two cover editing a date rule: the preview recomputes live as a step is changed
and shows the new deadline before anything is saved, a change with only
whitespace for a reason is refused by the server, a real one saves and survives
a reload — and a reviewer sees the list without links and is refused the editor
outright. One covers attaching a source document: a `.docx` whose bytes are a PDF is
refused, a real Word letter is accepted, scored and queued for reading, and it
appears in the table afterwards. Two cover starting an engagement: the form is reached from the engagements list,
refuses a corporate engagement with no year-end, creates one from a new client,
then refuses a second for the same year — and is neither offered to nor reachable
by a role without `engagement:create`. Two cover the annual rollout: the control says how many drafts it will produce,
a dry run reports without queueing, and the real run asks for confirmation
naming the count before it queues. Four more cover the work a reviewer actually
does. The Client Information tab
must offer a labelled form — not a box asking for a raw token — save a value that
survives a reload, refuse one that fails its own definition (with a value the
browser's own email check lets through, so the server rule is what is tested),
and show a fee as read-only because the pricing engine decides it.

Preparing an engagement
from the Overview tab must leave the balance-due day blocked, ask the question
that unblocks it, recalculate when it is answered, and leave every service
unconfirmed. And a generated PDF must be readable in place: the test puts a real
working copy where the server will find it, then asserts the frame's signed
`src`, a `200 application/pdf` served `inline` with `X-Frame-Options:
SAMEORIGIN` and `frame-ancestors 'self'` — a blanket `DENY` would leave a blank
panel — a `403` for a tampered signature and a `401` for the same link without a
session.

## Structural regression

The rendering tests are the regression suite for document fidelity. They assert
the logo is present and unchanged, headings and required text survive, tables
stay intact, page count stays within range, no placeholder remains, no internal
checklist appears, and no highlight reaches client output.

Rendering is deterministic — a fixed archive timestamp means identical inputs
produce a byte-identical file — so a file hash is a meaningful identity and any
unintended change shows up as a diff.

## Defects these tests found

Each was fixed in the code, not the test:

1. `requiredWhenSection` was dead unless the field was also unconditionally
   required, so CSRS 4200 fields were not enforced through that path.
2. The paragraph diff only merged a removal with an addition when they were
   adjacent, so ordinary clause edits showed as unrelated pairs.
3. The cover-letter service skipped its `GENERATING` state when called directly
   rather than through the worker.
4. The state machine had no way out of `COVER_LETTER_REVIEW_REQUIRED` when a
   source document changed while the letter sat in the review queue.
5. `audit_event`'s foreign keys made every engagement undeletable, because
   `ON DELETE SET NULL` is an update and the immutability trigger refused it.
6. The Content-Security-Policy blocked `'unsafe-eval'`, which React Refresh
   needs, so **the entire application was non-interactive under `next dev`** —
   every button and tab inert.
7. The global `X-Frame-Options: DENY` and `frame-ancestors 'none'` applied to
   the download route too, so the new document preview would have been a blank
   panel. Narrowed to `SAMEORIGIN` / `frame-ancestors 'self'` on that one route.
8. An uncatalogued date fact rendered as "has Non Resident Beneficiary" —
   readable, but not a sentence anyone would write.
9. Generation had no precedence rule for a token with several rows, so which
   value reached the client depended on the order Postgres returned them — and a
   resolved conflict was recorded but never applied to anything.
10. `writeDocx` let JSZip invent folder entries stamped with the wall clock, so
    two identical renders produced different bytes. A document hash was not the
    identity the audit trail treats it as. Rendering twice in a row could not
    catch it; both calls land in the same second.
11. The audit trail's own redaction stripped any payload key matching `token`,
    which is right for a credential and wrong for `corporation.legal_name` — so
    field edits, conflict resolutions and date confirmations recorded *that*
    something changed without recording *what*.
12. `BulkRolloutService.run` enqueued generation directly under a per-batch key,
    so two rollouts covering the same engagement produced two drafts — and
    `BULK_ROLLOUT_ITEM`, the job type that exists to re-enqueue under the
    deterministic per-engagement key, was never used by anything.
13. `run` queued whatever ids it was handed without re-checking them, so a
    blocked engagement could be generated by editing a disabled checkbox.
14. React 19 resets a form's DOM after a server action, which left the dry-run
    checkbox showing unchecked while the component still believed it was on.
    Replaced with two submit buttons, so the choice travels with the submission
    instead of living in state.
15. The same reset threw away everything a user had typed whenever a submission
    was rejected — being told the year-end is missing *and* losing the client
    name is how a person gives up on a form. `ActionForm` now restores the
    submission when the answer comes back "no".
16. `instanceof Prisma.PrismaClientKnownRequestError` is false inside Next's
    server bundle, because the generated Prisma runtime is loaded more than once
    in that process. Every handled unique-constraint violation — a duplicate
    engagement, a raced job enqueue, a duplicate webhook — surfaced as an
    unhandled "something went wrong" in the web app while passing in tests.
    Matching on the documented error code instead.
17. The draft disqualifier fired on any document containing the word "draft"
    unless it also contained "final" — and the approved T2 letter offers "a
    draft return or filing summary for management review". A genuine prior-year
    letter whose only "final" sat inside a removed conditional section was
    rejected as a draft. Narrowed to markers that say the *document* is a draft.
18. Confirming an uploaded document on "no disqualifiers" would have accepted
    another client's letter, which raises none. Confirmation now needs the
    contents to clear the acceptance threshold.

## What is not covered

Stated plainly rather than implied:

- **No test runs against a live Karbon or Adobe Sign tenant.** Both providers
  are exercised only through mock adapters. The mocks reproduce idempotency,
  parallel signing, decline, expiry and signed webhooks, but they cannot prove
  the real API behaves as documented.
- **Entra ID sign-in is not exercised end to end.** The OIDC flow is
  implemented and unit-reachable; browser tests use the development login.
- **No visual pixel-diff regression.** Fidelity is asserted structurally — logo
  bytes, part equality, table counts, page ranges — which catches the failures
  that matter without a screenshot baseline to maintain.
- **No load or concurrency testing** beyond the two-worker claim test.
- **AI extraction has no integration test.** Its guards — schema validation,
  evidence verification, confidence threshold — are implemented and readable
  but not covered by a test that calls a provider.
