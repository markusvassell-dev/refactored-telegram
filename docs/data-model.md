# Data model

PostgreSQL via Prisma. 36 entities. Money is `NUMERIC(12,2)` throughout and
never touches binary floating point.

## Entities

### Identity

| Entity | Purpose |
| --- | --- |
| `User` | Firm staff. `entraObjectId` links to Entra ID; null only for seeded development accounts. |
| `UserRole` | Role grants. Additive; a user may hold several. |

### Clients and Karbon

| Entity | Purpose |
| --- | --- |
| `Client` | Legal name, business number, trust account number, address, group, partner. `isTestFixture` marks sample data. |
| `ClientContact` | People at the client, with the Karbon contact key. |
| `KarbonWorkItem` | Local mirror of a work item, with `rawSnapshot` for the activity view. |

### Engagements

| Entity | Purpose |
| --- | --- |
| `Engagement` | The unit of work: client, type, tax year, year-end, status, template version, prior-year link, assignments, `compilationSelected`, `blockedReason`, `isTestMode`. |
| `EngagementParticipant` | Taxpayers, signing officers, representatives, firm signers. Carries signing order, `capacityConfirmed` and `contactConfirmed`. |

`compilationSelected` is **tri-state**. `null` means a reviewer has not yet
confirmed it, and generation is blocked until they do. It is not a boolean with
a default, because "we don't know" is a real and important state.

### Templates

| Entity | Purpose |
| --- | --- |
| `DocumentTemplate` | One per document type. `isProductionSupported` is false for types with no approved template. |
| `TemplateVersion` | Immutable once published: source hash, normalised hash, manifest, lifecycle timestamps. |
| `TemplateFieldDefinition` | The manifest's fields, flattened. This is what the review UI renders the structured form from — label, data type, help text, permitted enum values, length limit, and the conditional section that makes a field mandatory. |

### Documents

| Entity | Purpose |
| --- | --- |
| `SourceDocument` | A retrieved document: hash, verification score and signals, whether a human confirmed it, whether it is final and in the delivery package, and what superseded it. |
| `DocumentVersion` | A generated document: version number, status, template version, file references and hashes, page count, Karbon ids, the exact rendered field values, and the validation report. |

`renderedFieldValues` is an audit-grade snapshot: it answers "what values
produced this file" years later, even if the engagement has moved on.

### Extraction

| Entity | Purpose |
| --- | --- |
| `ExtractedField` | A value with its source, extraction method, confidence, whether a person confirmed it, and any manual override. |
| `FieldEvidence` | Where a value came from: source document, its hash at extraction time, page number, and a truncated supporting excerpt. |
| `FieldConflict` | Competing values, the recommended one, and the reviewer's decision. |

Evidence stores a citation and an excerpt, never a whole document.

### Pricing

| Entity | Purpose |
| --- | --- |
| `FeeRule` | A rule at one of five levels, with method, values, `skipRounding` and `appliesToAncillaryCharges`. |
| `FeeCalculation` | The full derivation: previous fee and its source, method, unrounded result, rounded result, increase, effective percentage, warnings, required approval, and whether it is blocked. |

The whole derivation is stored, not just the answer, because a reviewer has to
be able to see how a number was reached.

### Dates

| Entity | Purpose |
| --- | --- |
| `DateRule` | A configurable declarative definition. |
| `CalculatedDate` | Result plus the rule used, the input, the assumptions, whether confirmation is required, who confirmed it, and whether it is blocked for missing facts. |

### Review and approval

| Entity | Purpose |
| --- | --- |
| `ReviewAssignment` | Who is reviewing what. |
| `ReviewComment` | Internal comments, optionally anchored to a field or section. |
| `Approval` | An explicit decision: type, decision, user, acting role, comments, exceptions accepted, **the hash of the exact file approved**, and the source-document versions. |
| `WordingException` | Original wording, revised wording, reason, author, approver. Scoped to one document version. |

### Signing

| Entity | Purpose |
| --- | --- |
| `AdobeAgreement` | Agreement id, deterministic idempotency key, status, signing attempt, expiry, CC list, and the returned signed PDF and certificate with their hashes. |
| `AdobeSigner` | Per-signer status and timestamps. |
| `AdobeEvent` | Raw webhook events, keyed by provider event id for exactly-once processing. |
| `ExternalSignature` | A signature obtained outside this application and recorded here, with the signed document as required evidence, the method, the date the client signed, and who recorded it. Deliberately a separate table rather than a flag on `AdobeAgreement`: the two are different kinds of evidence, and a shared boolean is the kind of distinction that gets dropped in a join. Immutable once written, except for the Karbon document id. See `docs/signing-without-acrobat-sign.md`. |
| `ExternalSignatureSigner` | Who the recorder confirmed had signed. A joint T1 needs both spouses; without a row each, a half-signed letter is indistinguishable from a complete one. |

### Cover letters

| Entity | Purpose |
| --- | --- |
| `CoverLetterPackage` | Type, optional participant (for per-taxpayer T1 letters), status, source fingerprint, the enclosure list, blocked and stale reasons, approval. |

### Operations

| Entity | Purpose |
| --- | --- |
| `KarbonActivity` | Every attempted Karbon operation with its outcome, including skipped-as-unsupported. |
| `IntegrationConnection` | Per-provider configuration, encrypted credentials, sandbox flag, last health check. |
| `BackgroundJob` | Job type, status, idempotency key, correlation id, payload, attempts, timings, failure reason, technical detail, and a human-readable message. |
| `WorkflowEvent` | Every status change with its reason and who caused it. |
| `AuditEvent` | The immutable trail. |
| `SystemSetting` | Runtime configuration, including Test Mode. |
| `WorkflowTransition` | The legal transitions, seeded from the state machine and enforced by a trigger. |

## Constraints that matter

### Uniqueness

- One engagement per `(clientId, engagementType, taxYear)`.
- One document version per `(engagementId, documentType, versionNumber)`.
- One fee calculation per `(engagementId, feeKind)`.
- `BackgroundJob.idempotencyKey`, `AdobeAgreement.idempotencyKey`,
  `AdobeEvent.providerEventId`, `KarbonActivity.idempotencyKey` — all unique.
- `ExtractedField` unique per scope using `NULLS NOT DISTINCT`, because
  Postgres would otherwise treat every engagement-level row as distinct.

### Partial unique indexes

```sql
-- At most one live agreement per engagement, whatever the caller does.
CREATE UNIQUE INDEX adobe_agreement_one_live_per_engagement
  ON adobe_agreement ("engagementId")
  WHERE status IN ('CREATED','OUT_FOR_SIGNATURE','PARTIALLY_SIGNED');

-- At most one live cover-letter package per target.
CREATE UNIQUE INDEX cover_letter_one_live_per_target
  ON cover_letter_package ("engagementId","documentType",COALESCE("participantId",''))
  WHERE status <> 'STALE';
```

### Check constraints

```sql
-- The round-up-to-$5 rule, enforced by the database.
CHECK ("roundedFee" IS NULL
       OR NOT "roundingApplied"
       OR (MOD("roundedFee", 5) = 0
           AND ("unroundedFee" IS NULL OR "roundedFee" >= "unroundedFee")));
```

Plus non-negative fees, and job attempts within bounds.

### Triggers

| Trigger | Effect |
| --- | --- |
| `engagement_status_transition_guard` | Rejects any transition not in `workflow_transition`. `DRAFT_READY → SENT_FOR_SIGNATURE` is impossible even by direct SQL. |
| `audit_event_no_update` / `audit_event_no_delete` | `audit_event` is append-only. |
| `template_version_immutability_guard` | A published version's manifest, hashes and version number cannot change. Only lifecycle columns may. |
| `document_version_immutability_guard` | An approved or signed version's hashes and rendered values cannot change. |

Each is covered by an integration test that asserts the rejection.

## Audit strategy

`audit_event` is append-only and has **no foreign keys**. That is deliberate
twice over: `ON DELETE SET NULL` is an update, which the immutability trigger
correctly refuses; and an audit trail must outlive the records it describes.
`userId` and `engagementId` are plain indexed columns, and the UI joins names
for display.

Before and after values are redacted before storage — the trail records that a
fee changed and by how much, not a client's social insurance number.

Every event carries a correlation id threading a whole operation together, from
the web request through every job it spawns.

## Deliberate choices

**Tri-state `compilationSelected`.** "Not yet confirmed" is a first-class state
that blocks generation.

**Fee derivation stored in full.** Previous fee, source, method, unrounded,
rounded, increase and effective percentage — because a reviewer must see the
reasoning, not just the number.

**Approvals record a file hash.** An approval that only pointed at a row could
be argued about. One that names the hash of the exact PDF cannot.

**Source fingerprints, not timestamps.** Staleness is detected by hashing the
selected source documents. A file that was touched but not changed does not
invalidate a cover letter; one whose contents changed always does.
