# Testing

```bash
pnpm typecheck          # tsc --noEmit across every package and app
pnpm lint               # eslint
pnpm test               # unit + integration  (496 tests)
pnpm test:unit          # 238 — no external dependencies
pnpm test:integration   # 258 — needs Postgres and LibreOffice Writer
pnpm test:e2e           # 49  — needs a browser
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

## Unit tests (238)

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

**Queue polling failure (9)** — the worker backs off geometrically and settles
at a minute rather than growing without bound, and never returns a delay a sleep
cannot use however absurd the failure count, because sleeping forever is how a
worker stops being a worker with nothing reporting it. A missing table is
reported as "the web service has not migrated yet" rather than
`relation "background_job" does not exist`, an unreachable database is
distinguished from a missing schema because the fix differs, and an
unrecognised failure says nothing rather than guessing.

**Pagination (29)** — nonsense in the query string reads as the first page
rather than an error or an empty one; the page size is capped so a hand-edited
URL cannot ask for the whole table; `skip` stays a usable integer however large
the page asked for. An empty page reports no range rather than a misleading
"0–10". Counting stops at a ceiling and says "more than 10,000" rather than a
number it did not finish computing, and exactly the ceiling is exact rather than
a floor. A page link carries every filter across, replaces the page rather than
accumulating them, escapes a value that would break the query string, and leaves
`page` off the first page so the plain URL stays canonical. Both paged queries
are asserted to order by a total order.

**Deployment configuration (29)** — the properties that decide whether a
misconfigured deployment is legible or opaque. The image exposes exactly one
port, because two make the health-check target a coin toss. The start scripts
take the port the platform assigns, check configuration before touching the
database, and name the failure — `DATABASE_URL` unset, migrations refused —
rather than letting it read as a health-check failure. Only the web service
migrates, so two services cannot race for the lock. `.dockerignore` excludes
every path that could carry a credential into a layer. The first-administrator
list is empty by default, case-folded, and tolerant of the spaces a person
leaves after a comma; production without Entra ID is refused, and the missing
key is named.

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

## Integration tests (258)

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

**Integration connections (19)** — the only place a vendor credential enters
the application, so the tests are about what it will not do. A stored secret is
encrypted and never appears in what the screen is given, nor in the audit trail,
which records a six-character fingerprint and the names of what was rotated. A
blank field keeps the stored value, so rotating a bearer token does not clear
the access key and re-saving the form does not wipe the connection; a credential
change invalidates the last successful check, because that check proved a
credential that is gone. Marking a connection production is refused while Test
Mode is on, enabling one with a missing credential is refused, and a base URL
that is not https is refused because a bearer token must not travel in clear
text. A failed connection check is stored with the vendor's own words rather
than thrown away, and a credential blob the current `ENCRYPTION_KEY` cannot
decrypt is treated as absent rather than crashing the screen an operator needs
in order to re-enter it.

**Roles and access (15)** — what it refuses, mostly. A change with no real
reason, a role already held, a role the person does not hold, and somebody
without `user:manage` are all refused. Two refusals exist because the
alternative cannot be undone from inside the application: removing your own
administrator role, and removing or deactivating the last active one. A role the
Entra ID directory granted is left alone, because revoking it here would undo
itself at the next sign-in while the audit trail claimed otherwise. Deactivation
is reversible, and every change records who made it and why.

**Publishing a template (17)** — against the real approved T2 source and a
genuinely revised copy of it. An upload is normalised and stored as a draft
without activating anything; the hash of what was uploaded is recorded so the
running system can be tied back to the file the firm approved. A PDF renamed
`.docx` is refused by its magic number, an empty file is refused, a revision that
removed a placeholder the manifest depends on is refused rather than rendering
literal brackets to a client, and the identical bytes twice are refused so a
double submit leaves one draft. Activating retires the version it replaces
without deleting it, leaves exactly one active version, refuses the person who
uploaded it, refuses a version already active, and refuses to bring a retired one
back. Only a draft can be discarded.

**The cover letter narrative (29)** — eleven against the real approved
templates and eighteen through the service. The edit replaces the narrative and
leaves every word after it identical; tokens inside the edited text still
resolve; the replacement inherits the formatting of the paragraph it replaced
rather than inventing one; the result still converts to a valid PDF and renders
byte-identically twice. A section key the template does not mark editable is
refused, as is a declared section the template no longer contains — rendering
the original wording while reporting the edit as applied is the one outcome that
must not happen. Through the service: only ORDINARY sections are reachable, an
empty narrative is refused rather than silently deleting the opening, an edit is
superseded rather than overwritten, the template's own wording is recorded on
every edit so "restore the original" restores what the firm approved, the
database keeps exactly one live edit per section and refuses to rewrite one in
place, and an approved letter is sent back for review rather than diverging from
what its approver read.

**Paging real rows (10)** — written as one transaction, so every row carries an
identical timestamp; the test asserts that premise before relying on it. Every
row is then shown exactly once, the sequence is the same whatever page size it
is read at, and no row appears on two consecutive pages. The bounded count is
confirmed to be genuinely bounded rather than a limit the database ignores —
a ceiling nothing enforces is a ceiling that does nothing.

**The first administrator (11)** — the only path to a role that does not go
through an existing administrator, so what it refuses is what matters. A listed
address is granted `ADMINISTRATOR`, once, with an audit entry naming why; a
near miss (`partner@firm.ca.evil.test`, `xpartner@firm.ca`) is refused rather
than matched loosely; an empty list — the default — grants nothing, and neither
does an empty address against a list containing one. Signing in again is a
no-op that does not bury the original grant under duplicates, a role an
administrator granted by hand is left exactly as it was, and only the user
signing in is granted anything, not everyone on the list.

**Editing a pricing rule (14)** — two failure modes drive these, and both are
silent in production: a rule scoped to nothing never matches, and a method with
no value produces no fee — the engagement simply stays blocked and nobody knows
why. So an engagement-type rule with no type, a client rule with no client, a
partner rule with neither partner nor group, and a percentage rule with no
percentage are all refused; `NO_INCREASE` is accepted without one, because it
needs none. A negative or unreadable amount is refused, as is a rule that stops
applying before it starts. Narrowing a rule's level clears the scope it no
longer uses and switching its method clears the old value, so neither can keep
matching on a leftover. A created rule is then resolved by `resolveRule` ahead
of the seeded global one and priced by `calculateFee`, which is what proves the
saved row is the one the engine reads. And an approved fee is counted separately
and left exactly as it was.

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

## Browser tests (27)

Playwright, Test Mode on.

Anonymous access refused **server-side**; the development login offered only in
a test environment; the Test Mode banner on every page; integrations reported
honestly as mocks with the capability matrix showing unverified and unsupported
levels; production sending un-armable while the environment sets `TEST_MODE`;
unsupplied templates shown as awaiting approval; a read-only user refused the
audit log; skip link, landmarks and ARIA tab wiring; health and readiness
endpoints; webhook signature rejection and the Adobe verification handshake.

Two cover editing a pricing rule: the preview shows $2,000 + 3% as $2,060 and
$1,234 + 3% as $1,275 — rounded up from $1,271.02, never down — flags a 25%
increase as needing partner approval before anything is saved, and the server
refuses a rule scoped to nothing. Two cover editing a date rule: the preview recomputes live as a step is changed
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
19. A correctly deployed application was unusable. Directory role mapping starts
    empty, so the first person to sign in got a user record and no roles — and
    granting a role requires an administrator who did not exist yet. There was
    no way in. `BOOTSTRAP_ADMIN_EMAILS` is the way out of that deadlock, and it
    is the only path to a role that does not go through an existing
    administrator.
20. The image exposed two ports. Railway infers the port it will health-check
    from the image, so the web service could be probed on the worker's port and
    the worker on the web service's — both deployments marked unhealthy while
    both processes ran correctly. One port now, and each service listens on
    whatever the platform assigns.
21. The worker ignored the platform's assigned port entirely and listened on
    `WORKER_HEALTH_PORT`, so its health endpoint was unreachable wherever that
    port was not the one being probed.
22. `.env.example` claimed the application "refuses to boot on a
    misconfiguration". The web service did not: the environment is validated on
    first use, so a missing `ENTRA_CLIENT_ID` produced a *healthy* deployment
    that returned 500 on every page. A pre-flight check now makes the claim
    true, and names the key in the deploy log.
23. `migrate && start` reported a database problem as "healthcheck failed",
    which is never the reason — `/api/health` does not touch the database, so a
    failing probe means nothing is listening. The start scripts say which
    failure it was.
24. There was no `.dockerignore`, so `COPY . .` carried a developer's local
    `node_modules` and `.next` into the image — and their `.env` with it. Prisma
    Client loads a project-root `.env` on import, so those values would have
    silently overridden the variables set on the platform.
25. The worker's configuration was in a second file, `railway.worker.json`,
    which Railway never reads unless each service is individually pointed at it.
    Missing that is silent: the worker ran the web service's start command and
    was probed on the web service's health path, then failed with a health-check
    error about neither. One config file now, and the role travels with the
    service's own variables as `SERVICE_ROLE`.
26. `DATABASE_URL` reported as "not set" when it was set and empty. Those are
    different faults with different fixes — an empty value means a platform
    reference that did not resolve, and telling someone to add a variable they
    can plainly see is already there sends them in a circle.
27. The worker wrote the same Prisma error every two seconds, indefinitely,
    whenever the queue was unreachable — which on a first deployment is every
    deployment, until the web service finishes migrating. Hundreds of identical
    lines buried the one that mattered, and log ingestion is not free. It now
    backs off to a minute, says the reason once with what to do about it, and
    reports recovery.
28. "Invalid URL" was true and useless. `APP_BASE_URL` set to `https://` — a
    scheme with no host — means a platform variable resolved to nothing, and the
    fix is to create the thing it points at, not to correct the variable. A
    placeholder value was worse still: valid, accepted, and silently wrong until
    someone tried to sign in.
29. **Paging the audit log lost events.** Both lists ordered by a non-unique
    column — `createdAt` for audit events, `updatedAt` for engagements — and SQL
    leaves tied rows in no defined sequence, so `OFFSET` over them drops some and
    repeats others. The ties are guaranteed rather than unlucky: Postgres `now()`
    is the transaction timestamp, so every audit event written by one bulk
    rollout shares a `createdAt` to the microsecond. Measured on 300 events
    written in one transaction: paging at 20 a page **lost 6 and showed 6 twice**.
    Every paged query now ends with a unique tiebreaker; the same measurement
    then returns all 300 exactly once.
30. Both lists stopped at a fixed number and said nothing — 200 engagements, 250
    audit events. A reader had no way to tell a short answer from a truncated
    one, which on an audit trail is the difference between a record and a
    suggestion.
31. An approved wording exception whose anchor no longer matched the template
    was skipped in silence: the document rendered the original approved wording
    while the record said the partner's change had been applied. That is how an
    unapproved sentence reaches a client. It now refuses to render.
32. `editableSections` was declared in every manifest, parsed into the manifest
    type, and read by nothing. The templates had said which paragraphs were
    meant to be written since the beginning; no code had ever honoured it.
33. Two browser suites reset "the oldest engagement" and then opened "the first
    row of the engagement list". Those were the same engagement only until a
    second one shared its tax year, after which a T2 test read a T1 and failed
    with an error about deadlines. Tests now navigate to the engagement they set
    up, by id.
34. The browser sign-in helper matched `/Reviewer/` against every user in the
    development login, and an integration fixture named "Creation Reviewer" —
    with no roles at all — sorted first. Signing in succeeded and every
    permission check then failed, which surfaces much later as a button
    mysteriously missing from a page.
35. The manifest-building half of template normalisation lived only in the
    normalisation CLI. Publishing from the application would have needed a
    second implementation, and two would eventually disagree — the symptom
    being an uploaded template rendering differently from a committed one.
    Extracted to `buildTemplateVersion`, and the CLI's output verified
    byte-identical afterwards.
36. Two tests written for this change mutated shared seeded data and did not put
    it back: one deactivated every administrator in the database, including the
    account the browser suite signs in with, and one granted a role to
    `Sample Viewer` and failed before removing it. Both broke a later suite with
    an error pointing nowhere near the cause. Fixture state is now restored in a
    `finally`, and the browser test uses a user it owns.
37. Four of the five Needs Attention queries had no `take` at all. An unbounded
    `findMany` is the same defect as a silent cap, one year later — fine until
    the season the firm has three hundred blocked engagements.
38. `workflowEvents` was fetched on every engagement page view and rendered
    nowhere: a join per request for data no screen showed. The status history it
    held is already in the audit trail as `STATUS_CHANGED`.
39. Adobe signing events were fetched the same way and also never shown, which
    left the provider's own account of a signing — including whether its webhook
    signature verified — invisible to the person reviewing it. Now rendered.
40. `KARBON_BEARER_TOKEN`, `KARBON_ACCESS_KEY` and the three Adobe Sign
    credential variables were declared in the environment schema and read by
    nothing. Only the database connection was ever consulted, so a deployment
    that set them saw no effect at all — and the deployment guide told people to
    set them. Removed: a vendor credential now has exactly one home.
41. The Integrations screen was read-only, while `docs/railway-deployment.md`
    said credentials could be entered there and the capability matrix's
    verification checklist opened with "configure a sandbox connection on the
    Integrations screen". There was no way to configure either integration, from
    the UI or the environment.
42. **Nobody could sign in.** `form-action 'self'` is checked against where a
    form submission ends up, not only where it was aimed, so the browser blocked
    the sign-in redirect to Microsoft — and blocked it silently. Clicking
    "Continue with Microsoft" did nothing at all, with the reason visible only
    in a console nobody had open. Reproduced in a real browser against the
    production build before the fix and after it; a browser test now asserts
    both that no policy violation fires and that the served header names the
    sign-in host.
43. Once sign-in could reach Microsoft, it arrived with `PASTE_YOUR_TENANT_ID`
    and came back `AADSTS900023`. The gate was `Boolean(tenantId && clientId)`,
    and a placeholder is a perfectly good non-empty string — so the deployment
    was green, the button was enabled, and the mistake was reported by a vendor
    rather than by the application that could see it. All three values are now
    checked for shape: staging and production refuse to boot on a malformed one
    exactly as they do on a missing one, the sign-in button is disabled with the
    reason on the page, and the route that builds the authorization URL declines
    to build it. Shape only — whether a well-formed GUID is a real directory is
    Microsoft's question to answer.

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
