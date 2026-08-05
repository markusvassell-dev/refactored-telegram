# Testing

```bash
pnpm typecheck          # tsc --noEmit across every package and app
pnpm lint               # eslint
pnpm test               # unit + integration  (250 tests)
pnpm test:unit          # 158 — no external dependencies
pnpm test:integration   # 92  — needs Postgres and LibreOffice Writer
pnpm test:e2e           # 18  — needs a browser
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

## Unit tests (158)

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

## Integration tests (92)

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

## Browser tests (18)

Playwright, Test Mode on.

Anonymous access refused **server-side**; the development login offered only in
a test environment; the Test Mode banner on every page; integrations reported
honestly as mocks with the capability matrix showing unverified and unsupported
levels; production sending un-armable while the environment sets `TEST_MODE`;
unsupplied templates shown as awaiting approval; a read-only user refused the
audit log; skip link, landmarks and ARIA tab wiring; health and readiness
endpoints; webhook signature rejection and the Adobe verification handshake.

Four of them cover the work a reviewer actually does. The Client Information tab
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
