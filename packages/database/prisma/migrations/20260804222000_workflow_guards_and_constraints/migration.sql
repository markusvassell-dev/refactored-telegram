-- Element Engagements — database-level integrity guarantees.
--
-- The application enforces all of these rules too. They are repeated here so
-- that a bug, a console session, or a future service cannot bypass them.

-- ---------------------------------------------------------------------------
-- 1. Workflow transitions
--
-- Seeded from packages/workflows/src/engagement-state-machine.ts. The test
-- `workflow-transition-sql.test.ts` fails if this seed drifts from that map.
-- ---------------------------------------------------------------------------

INSERT INTO "workflow_transition" ("fromStatus", "toStatus") VALUES
  ('NOT_STARTED', 'LOCATING_SOURCE_DOCUMENTS'),
  ('NOT_STARTED', 'EXTRACTING_DATA'),
  ('NOT_STARTED', 'GENERATING'),
  ('NOT_STARTED', 'NEEDS_ATTENTION'),
  ('LOCATING_SOURCE_DOCUMENTS', 'SOURCE_DOCUMENT_REVIEW_REQUIRED'),
  ('LOCATING_SOURCE_DOCUMENTS', 'EXTRACTING_DATA'),
  ('LOCATING_SOURCE_DOCUMENTS', 'GENERATION_FAILED'),
  ('LOCATING_SOURCE_DOCUMENTS', 'NEEDS_ATTENTION'),
  ('SOURCE_DOCUMENT_REVIEW_REQUIRED', 'LOCATING_SOURCE_DOCUMENTS'),
  ('SOURCE_DOCUMENT_REVIEW_REQUIRED', 'EXTRACTING_DATA'),
  ('SOURCE_DOCUMENT_REVIEW_REQUIRED', 'NEEDS_ATTENTION'),
  ('EXTRACTING_DATA', 'GENERATING'),
  ('EXTRACTING_DATA', 'SOURCE_DOCUMENT_REVIEW_REQUIRED'),
  ('EXTRACTING_DATA', 'GENERATION_FAILED'),
  ('EXTRACTING_DATA', 'NEEDS_ATTENTION'),
  ('GENERATING', 'DRAFT_READY'),
  ('GENERATING', 'GENERATION_FAILED'),
  ('GENERATING', 'NEEDS_ATTENTION'),
  ('GENERATION_FAILED', 'GENERATING'),
  ('GENERATION_FAILED', 'REGENERATING'),
  ('GENERATION_FAILED', 'LOCATING_SOURCE_DOCUMENTS'),
  ('GENERATION_FAILED', 'NEEDS_ATTENTION'),
  ('DRAFT_READY', 'REVIEW_REQUIRED'),
  ('DRAFT_READY', 'REGENERATING'),
  ('DRAFT_READY', 'NEEDS_ATTENTION'),
  ('REVIEW_REQUIRED', 'IN_REVIEW'),
  ('REVIEW_REQUIRED', 'CHANGES_REQUESTED'),
  ('REVIEW_REQUIRED', 'NEEDS_ATTENTION'),
  ('IN_REVIEW', 'APPROVED'),
  ('IN_REVIEW', 'CHANGES_REQUESTED'),
  ('IN_REVIEW', 'REVIEW_REQUIRED'),
  ('IN_REVIEW', 'NEEDS_ATTENTION'),
  ('CHANGES_REQUESTED', 'REGENERATING'),
  ('CHANGES_REQUESTED', 'IN_REVIEW'),
  ('CHANGES_REQUESTED', 'NEEDS_ATTENTION'),
  ('REGENERATING', 'DRAFT_READY'),
  ('REGENERATING', 'GENERATION_FAILED'),
  ('REGENERATING', 'NEEDS_ATTENTION'),
  ('APPROVED', 'READY_TO_SEND'),
  ('APPROVED', 'CHANGES_REQUESTED'),
  ('APPROVED', 'NEEDS_ATTENTION'),
  ('READY_TO_SEND', 'SENDING_FOR_SIGNATURE'),
  ('READY_TO_SEND', 'CHANGES_REQUESTED'),
  ('READY_TO_SEND', 'NEEDS_ATTENTION'),
  ('SENDING_FOR_SIGNATURE', 'SENT_FOR_SIGNATURE'),
  ('SENDING_FOR_SIGNATURE', 'READY_TO_SEND'),
  ('SENDING_FOR_SIGNATURE', 'NEEDS_ATTENTION'),
  ('SENT_FOR_SIGNATURE', 'PARTIALLY_SIGNED'),
  ('SENT_FOR_SIGNATURE', 'SIGNED'),
  ('SENT_FOR_SIGNATURE', 'DECLINED'),
  ('SENT_FOR_SIGNATURE', 'EXPIRED'),
  ('SENT_FOR_SIGNATURE', 'NEEDS_ATTENTION'),
  ('PARTIALLY_SIGNED', 'SIGNED'),
  ('PARTIALLY_SIGNED', 'DECLINED'),
  ('PARTIALLY_SIGNED', 'EXPIRED'),
  ('PARTIALLY_SIGNED', 'NEEDS_ATTENTION'),
  ('SIGNED', 'COMPLETE'),
  ('SIGNED', 'NEEDS_ATTENTION'),
  ('DECLINED', 'REGENERATING'),
  ('DECLINED', 'NEEDS_ATTENTION'),
  ('EXPIRED', 'READY_TO_SEND'),
  ('EXPIRED', 'REGENERATING'),
  ('EXPIRED', 'NEEDS_ATTENTION'),
  ('NEEDS_ATTENTION', 'LOCATING_SOURCE_DOCUMENTS'),
  ('NEEDS_ATTENTION', 'SOURCE_DOCUMENT_REVIEW_REQUIRED'),
  ('NEEDS_ATTENTION', 'EXTRACTING_DATA'),
  ('NEEDS_ATTENTION', 'GENERATING'),
  ('NEEDS_ATTENTION', 'GENERATION_FAILED'),
  ('NEEDS_ATTENTION', 'REGENERATING'),
  ('NEEDS_ATTENTION', 'DRAFT_READY'),
  ('NEEDS_ATTENTION', 'REVIEW_REQUIRED'),
  ('NEEDS_ATTENTION', 'IN_REVIEW'),
  ('NEEDS_ATTENTION', 'CHANGES_REQUESTED'),
  ('NEEDS_ATTENTION', 'READY_TO_SEND'),
  ('NEEDS_ATTENTION', 'SENDING_FOR_SIGNATURE'),
  ('NEEDS_ATTENTION', 'SENT_FOR_SIGNATURE'),
  ('NEEDS_ATTENTION', 'PARTIALLY_SIGNED'),
  ('NEEDS_ATTENTION', 'SIGNED'),
  ('NEEDS_ATTENTION', 'DECLINED'),
  ('NEEDS_ATTENTION', 'EXPIRED'),
  ('NEEDS_ATTENTION', 'COMPLETE'),
  ('NEEDS_ATTENTION', 'READY_FOR_COVER_LETTER'),
  ('NEEDS_ATTENTION', 'COVER_LETTER_GENERATING'),
  ('NEEDS_ATTENTION', 'COVER_LETTER_REVIEW_REQUIRED'),
  ('NEEDS_ATTENTION', 'COVER_LETTER_IN_REVIEW'),
  ('NEEDS_ATTENTION', 'COVER_LETTER_CHANGES_REQUESTED'),
  ('NEEDS_ATTENTION', 'READY_FOR_DELIVERY'),
  ('COMPLETE', 'READY_FOR_COVER_LETTER'),
  ('COMPLETE', 'NEEDS_ATTENTION'),
  ('READY_FOR_COVER_LETTER', 'COVER_LETTER_GENERATING'),
  ('READY_FOR_COVER_LETTER', 'NEEDS_ATTENTION'),
  ('COVER_LETTER_GENERATING', 'COVER_LETTER_REVIEW_REQUIRED'),
  ('COVER_LETTER_GENERATING', 'GENERATION_FAILED'),
  ('COVER_LETTER_GENERATING', 'NEEDS_ATTENTION'),
  ('COVER_LETTER_REVIEW_REQUIRED', 'COVER_LETTER_IN_REVIEW'),
  ('COVER_LETTER_REVIEW_REQUIRED', 'NEEDS_ATTENTION'),
  ('COVER_LETTER_IN_REVIEW', 'COVER_LETTER_APPROVED'),
  ('COVER_LETTER_IN_REVIEW', 'COVER_LETTER_CHANGES_REQUESTED'),
  ('COVER_LETTER_IN_REVIEW', 'NEEDS_ATTENTION'),
  ('COVER_LETTER_CHANGES_REQUESTED', 'COVER_LETTER_GENERATING'),
  ('COVER_LETTER_CHANGES_REQUESTED', 'COVER_LETTER_IN_REVIEW'),
  ('COVER_LETTER_CHANGES_REQUESTED', 'NEEDS_ATTENTION'),
  ('COVER_LETTER_APPROVED', 'READY_FOR_DELIVERY'),
  ('COVER_LETTER_APPROVED', 'COVER_LETTER_CHANGES_REQUESTED'),
  ('COVER_LETTER_APPROVED', 'NEEDS_ATTENTION'),
  ('READY_FOR_DELIVERY', 'COVER_LETTER_CHANGES_REQUESTED'),
  ('READY_FOR_DELIVERY', 'NEEDS_ATTENTION')
ON CONFLICT DO NOTHING;
CREATE OR REPLACE FUNCTION enforce_engagement_status_transition() RETURNS trigger AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    IF NOT EXISTS (
      SELECT 1 FROM "workflow_transition"
      WHERE "fromStatus" = OLD."status" AND "toStatus" = NEW."status"
    ) THEN
      RAISE EXCEPTION 'Illegal engagement status transition: % -> %', OLD."status", NEW."status"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER engagement_status_transition_guard
  BEFORE UPDATE ON "engagement"
  FOR EACH ROW EXECUTE FUNCTION enforce_engagement_status_transition();

-- ---------------------------------------------------------------------------
-- 2. Immutable audit trail
--
-- Ordinary application users may never edit or delete an audit event. Neither
-- may the application itself: there is no code path that can rewrite history.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION reject_audit_event_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_event rows are immutable and cannot be updated or deleted'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_event_no_update
  BEFORE UPDATE ON "audit_event"
  FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();

CREATE TRIGGER audit_event_no_delete
  BEFORE DELETE ON "audit_event"
  FOR EACH ROW EXECUTE FUNCTION reject_audit_event_mutation();

-- ---------------------------------------------------------------------------
-- 3. Published template versions are immutable
--
-- Updating a template must create a new version. Only lifecycle columns
-- (status, retiredAt, activatedAt) may change once a version is published.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_template_version_immutability() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IN ('ACTIVE', 'RETIRED') THEN
    IF NEW."manifest"::text IS DISTINCT FROM OLD."manifest"::text
       OR NEW."sourceFileHash" IS DISTINCT FROM OLD."sourceFileHash"
       OR NEW."normalizedFileHash" IS DISTINCT FROM OLD."normalizedFileHash"
       OR NEW."versionNumber" IS DISTINCT FROM OLD."versionNumber"
       OR NEW."templateId" IS DISTINCT FROM OLD."templateId" THEN
      RAISE EXCEPTION 'A published template version is immutable. Create a new version instead.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER template_version_immutability_guard
  BEFORE UPDATE ON "template_version"
  FOR EACH ROW EXECUTE FUNCTION enforce_template_version_immutability();

-- ---------------------------------------------------------------------------
-- 4. Approved and signed document versions are immutable
--
-- A new edit always creates a new version; it never rewrites an approved one.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_document_version_immutability() RETURNS trigger AS $$
BEGIN
  IF OLD."status" IN ('APPROVED', 'SENT_FOR_SIGNATURE', 'SIGNED', 'SUPERSEDED') THEN
    IF NEW."docxHash" IS DISTINCT FROM OLD."docxHash"
       OR NEW."pdfHash" IS DISTINCT FROM OLD."pdfHash"
       OR NEW."versionNumber" IS DISTINCT FROM OLD."versionNumber"
       OR NEW."documentType" IS DISTINCT FROM OLD."documentType"
       OR NEW."renderedFieldValues"::text IS DISTINCT FROM OLD."renderedFieldValues"::text THEN
      RAISE EXCEPTION 'An approved or signed document version cannot be modified. Create a new version instead.'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER document_version_immutability_guard
  BEFORE UPDATE ON "document_version"
  FOR EACH ROW EXECUTE FUNCTION enforce_document_version_immutability();

-- ---------------------------------------------------------------------------
-- 5. Pricing invariants
--
-- The round-up-to-$5 rule is enforced by the database, not only by the engine.
-- ---------------------------------------------------------------------------

ALTER TABLE "fee_calculation"
  ADD CONSTRAINT "fee_calculation_non_negative"
  CHECK (
    ("roundedFee" IS NULL OR "roundedFee" >= 0)
    AND ("unroundedFee" IS NULL OR "unroundedFee" >= 0)
    AND ("previousFee" IS NULL OR "previousFee" >= 0)
  );

ALTER TABLE "fee_calculation"
  ADD CONSTRAINT "fee_calculation_rounds_up_to_five"
  CHECK (
    "roundedFee" IS NULL
    OR NOT "roundingApplied"
    OR (MOD("roundedFee", 5) = 0 AND ("unroundedFee" IS NULL OR "roundedFee" >= "unroundedFee"))
  );

ALTER TABLE "fee_rule"
  ADD CONSTRAINT "fee_rule_amounts_non_negative"
  CHECK (
    ("fixedAmount" IS NULL OR "fixedAmount" >= 0)
    AND ("exactTarget" IS NULL OR "exactTarget" >= 0)
  );

-- ---------------------------------------------------------------------------
-- 6. Duplicate-prevention
--
-- At most one live Adobe Sign agreement per engagement. A retry that slipped
-- past the idempotency key still cannot create a second live agreement.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX "adobe_agreement_one_live_per_engagement"
  ON "adobe_agreement" ("engagementId")
  WHERE "status" IN ('CREATED', 'OUT_FOR_SIGNATURE', 'PARTIALLY_SIGNED');

-- At most one live cover-letter package per engagement / type / participant.
CREATE UNIQUE INDEX "cover_letter_one_live_per_target"
  ON "cover_letter_package" ("engagementId", "documentType", COALESCE("participantId", ''))
  WHERE "status" <> 'STALE';

-- ---------------------------------------------------------------------------
-- 7. Nullable-column uniqueness
--
-- Postgres treats NULLs as distinct by default, which would let the same field
-- be extracted twice at engagement level. PG15+ NULLS NOT DISTINCT fixes that.
-- ---------------------------------------------------------------------------

DROP INDEX IF EXISTS "extracted_field_engagementId_coverLetterPackageId_token_sou_key";

CREATE UNIQUE INDEX "extracted_field_unique_per_scope"
  ON "extracted_field" ("engagementId", "coverLetterPackageId", "token", "source")
  NULLS NOT DISTINCT;

-- ---------------------------------------------------------------------------
-- 8. Background job invariants
-- ---------------------------------------------------------------------------

ALTER TABLE "background_job"
  ADD CONSTRAINT "background_job_attempts_within_bounds"
  CHECK ("attempt" >= 0 AND "maxAttempts" > 0 AND "attempt" <= "maxAttempts" + 1);
