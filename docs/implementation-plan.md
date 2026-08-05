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

The bulk rollout preview is real: it resolves the price rule per engagement,
computes unrounded and rounded fees, and reports missing fields, warnings and
blockers. `BulkRolloutService.run` queues generation with deterministic keys
and never sends to Adobe Sign.

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

**Bulk rollout has no selection UI.** The preview renders with checkboxes, but
submitting a selection is not wired to `BulkRolloutService.run`. The service is
complete and idempotent; the form is not connected.

**Cover-letter editing is partial.** Extracted values, evidence, enclosures,
approval and staleness all work. The in-place editor for cover-letter narrative
sections is defined in the manifests (`editableSections` with `ORDINARY`) but
has no UI; wording edits go through the exceptional-edit path instead.

**Conflict detection is not automatic.** `FieldConflict` is modelled, displayed
and resolvable, and resolution is audited, but nothing yet compares current
Karbon values against prior-year values to *create* the rows.

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

## Next implementation step

**Automatic conflict detection.** `FieldConflict` is modelled, displayed,
resolvable and audited, but nothing compares current Karbon values against
prior-year extracted values to *create* the rows, so the reviewer sees a
conflict only if one is inserted by hand.

The work is a reconciliation pass in the extraction job: for each token present
from more than one source, compare the normalised values; where they differ,
create a `FieldConflict` with both candidates and recommend the higher-priority
source (current Karbon over the prior-year document), leaving the decision to a
person. `sourceRank()` in `@element/shared` already encodes the priority order,
and the review UI already renders and resolves whatever rows exist.

It is the highest-value gap because it is the one place where the requirement
"do not silently choose one" currently depends on there being nothing to
choose between.

After that, in order: the bulk rollout selection form, the administration write
UI, and the cover-letter narrative editor.
