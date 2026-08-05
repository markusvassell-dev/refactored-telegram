# Implementation plan and status

## What was inspected first

The repository was empty — no commits, no framework, no existing features, so
nothing had to be preserved or replaced.

All five approved templates were present and were inspected structurally before
any code was written: every paragraph, table, table row and cell, every
checkbox glyph, every highlighted run, and every bracketed placeholder with its
surrounding context.

| Template | Paragraphs | Tables | Highlighted runs | Placeholders |
| --- | --- | --- | --- | --- |
| T2 Engagement Letter | 196 | 4 | 29 (all yellow) | 45 occurrences |
| T1 Joint Taxpayer Engagement Letter | 100 | 3 | 0 | 19 |
| T3 Trust Engagement Letter | 102 | 2 | 0 | 18 |
| T1 Cover Letter | 126 | 4 | 0 | 22 |
| Compilation Engagement Cover Letter | 125 | 4 | 0 | 23 |

Findings that shaped the design:

- **`[DATE]` appears four times in the T2 template with four different
  meanings** — date sent, information due, filing due, and an acceptance
  signature date that must never be prefilled. Placeholder mapping therefore
  had to be positionally scoped, not text-only.
- The T2 template ends with an **internal customization checklist** that must
  never reach a client, and carries **29 yellow-highlighted runs**.
- Section 3A and the Schedule A compilation particulars are two separate
  ranges, both conditional on the same selection.
- Checkboxes are literal `☐` / `☒` characters in paragraph text, not content
  controls.
- The compilation cover letter's enclosure list is static prose, so making it
  dynamic means removing bullets rather than filling a list.
- The T1 cover letter is written for **one** taxpayer, so a joint engagement
  needs one letter per taxpayer.
- No template contains a text box, so top-level block parsing is reliable.

## Phase status

| Phase | Status |
| --- | --- |
| **0 — Discovery and foundation** | Complete |
| **1 — T2 engagement letter** | Complete |
| **2 — Adobe Sign** | Complete against a mock; unverified against a live account |
| **3 — Compilation cover letter** | Complete |
| **4 — T1** | Generation, signing model and per-taxpayer cover letters complete; see gaps |
| **5 — T3** | Generation and signing model complete; see gaps |
| **6 — Bulk rollout and administration** | Preview and queueing complete; see gaps |

### Starting an engagement

Until now an engagement existed only because the seed made one: the Karbon sync
job upserts work items but does not create engagements, and the bulk rollout
queues generation for engagements that already exist. `/engagements/new` closes
that, which is what makes a Test Mode pilot possible before Karbon has been
verified against a live tenant.

It refuses what cannot be recovered from later: a type with no approved template,
a corporate or trust engagement without the year-end its deadlines are computed
from, an implausible tax year, a duplicate for the same client and year, and a
new client whose name already exists. It links the prior year automatically, and
a Karbon work item only when this application already knows it.

### Phase 0 — complete

Monorepo, 36-entity data model, database-level guards, workflow state machine,
pricing engine, date-rule engine, RBAC with separation of duties, template
normalisation (127 placeholders, zero unmapped), provider interfaces, Test
Mode, Docker and Railway configuration, and the documentation set.

### Phase 1 — complete

Karbon work item connection, prior-year search and content verification, field
extraction with evidence, comparison against current Karbon data, the pricing
engine, CSRS 4200 confirmation, T2 generation, Word and PDF rendering,
validation and sanitation, Karbon upload and notification, the fifteen-tab
review workspace, and the approval workflow.

`PREPARE_ENGAGEMENT` is what joins extraction to generation. It records the
current Karbon values as their own source, raises a `FieldConflict` wherever
sources disagree, seeds one unconfirmed `ServiceSelection` per template
checkbox, calculates every fee, and evaluates the date rules — blocking any
deadline whose inputs are unknown rather than assuming the common case. It is
idempotent and never overwrites a value, date or selection a person has
confirmed, so a reviewer can re-run it safely.

A reviewer reads the PDF in the workspace, in a same-origin frame served by a
signed link that expires in fifteen minutes. Approving a document you cannot
see is not a workflow this application asks anyone to perform.

### Phase 2 — complete against a mock

OAuth refresh, text-tag anchors, the signer model, agreement creation with
deterministic idempotency, Test Mode sending, webhook processing with
exactly-once semantics, status tracking, signed PDF and certificate retrieval,
and the Karbon return workflow.

**Not verified against a live Adobe account.** The Integrations screen reports
it as unverified until a health check succeeds.

### Phase 3 — complete

Final-document checklist, source-document version tracking, extraction from
final documents, the dynamic enclosure list, cover-letter generation, human
review and approval, and stale-source detection.

### Phase 4 — mostly complete

The T1 joint template renders with all its fields and both taxpayer signature
blocks. The dual-taxpayer parallel signing model is implemented and tested. Fee
handling and the review and approval workflow are shared with T2. The T1 cover
letter renders per taxpayer.

T1 **single** engagement generation is deliberately unavailable — no approved
single-taxpayer template exists, and none will be invented.

### Phase 5 — mostly complete

The T3 template renders with the representative and capacity fields. Capacity
is marked `autoPopulatable: false`, so it is never assumed and must be
confirmed. The signer workflow, review and approval are shared.

The T3 completion cover letter is deliberately unavailable — no approved
template exists.

### Phase 6 — partially complete

The bulk rollout runs end to end. The preview resolves the price rule per
engagement, computes unrounded and rounded fees, and reports missing fields,
warnings and blockers; the selection form says how many drafts it will produce,
offers a dry run, and asks for confirmation naming that number before it queues
anything. Nothing reaches Adobe Sign, and every draft still goes through
individual review and approval.

Two protections, because this is the only action that touches many clients at
once. Every selected engagement is re-evaluated server-side rather than trusted
from the submitted list, so a blocked row cannot be generated by editing a
disabled checkbox. And work is queued as a `BULK_ROLLOUT_ITEM` that re-enqueues
generation under the deterministic per-engagement key: the batch key stops a
double submission, the generation key stops a second rollout producing a second
draft.

Template, pricing-rule, date-rule and user administration screens are read-only
views over live data. Audit reporting, dashboards and failure management are
complete.

## Known gaps

Stated plainly.

**Integrations unverified.** Neither Karbon nor Adobe Sign has been exercised
against a live tenant from this codebase. Both are implemented against
published documentation and clearly reported as `unverified`.

**Administration screens are read-only.** Templates, Pricing Rules, Date Rules
and Users show live data but have no create or edit forms. The services behind
them exist and are tested; the write UI does not. Changes are made through the
database or the seed today.

**Cover-letter editing is partial.** Extracted values, evidence, enclosures,
approval and staleness all work. The in-place editor for cover-letter narrative
sections is defined in the manifests (`editableSections` with `ORDINARY`) but
has no UI; wording edits go through the exceptional-edit path instead.

**No malware scanning.** The integration point is `DocumentStore.put` — the
single choke point every stored byte passes through, already validating type
and size.

**Production CSP still allows `'unsafe-inline'` for scripts.** Next.js needs it
for hydration data unless a nonce is issued from middleware.

**Entra sign-in has not been exercised against a real tenant.** The
authorization-code flow with PKCE is implemented end to end — `/api/auth/entra/start`
and `/api/auth/entra/callback`, with `state`, `nonce` and the PKCE verifier
sealed into a short-lived cookie and verified on return, directory roles mapped
through the `entra_role_mapping` setting, and the user created or updated on
first sign-in. It has only been typechecked and reviewed, not run against a
live directory. Browser tests use the development login.

**`sourcePlaceholder` needs a new template version to appear.** The bracketed
text a token replaced is derived during normalisation and written into the
manifest. A published template version is immutable, and rightly so, which means
a deployment seeded before this change shows the placeholder only once a new
version is published. The other three field properties are backfilled from the
stored manifest by migration and need nothing.

## Next implementation step

**Locating and extracting a prior-year letter without Karbon.** Preparation,
pricing and the whole review workspace assume a prior-year letter has been
found and read. Every path to one runs through Karbon: `LOCATE_PRIOR_YEAR_DOCUMENTS`
searches work items, and the extraction job reads what that found. In Test Mode
with the mock adapter there is nothing real to find, so a pilot can create an
engagement and then cannot get past a blocked fee.

The work is an upload on the Source Documents tab: accept a `.docx` or `.pdf`,
store it through `DocumentStore.put` (which already validates type, size and
path), record it as a `SourceDocument` with its hash, and enqueue
`EXTRACT_DOCUMENT_TEXT` against it. The extraction, verification scoring,
evidence and staleness machinery all already exist and are tested — what is
missing is the one way to hand them a file by hand.

After that, in order: the administration write UI (templates, pricing rules,
date rules, users), and the cover-letter narrative editor.
