-- Recording a signature obtained outside this application.
--
-- Acrobat Pro with e-sign, which the firm has, exposes no API. Acrobat Sign
-- Solutions, which does, is a separate paid product. Until it is bought, an
-- approved letter can never become a signed one and the entire second half of
-- the workflow — completion, cover letters, delivery — is unreachable.
--
-- This lets a person record a signature they obtained by other means, with the
-- signed file as evidence. It is deliberately a separate table from
-- adobe_agreement rather than a flag on it: an Adobe signature carries Adobe's
-- own audit trail and certificate, this one carries one person's word plus a
-- file, and a boolean shared between them is the kind of distinction that gets
-- dropped in a join or defaulted on an insert.

CREATE TYPE "ExternalSignatureMethod" AS ENUM ('ACROBAT_ESIGN', 'WET_INK', 'OTHER_ELECTRONIC');

CREATE TABLE "external_signature" (
  "id"                TEXT NOT NULL,
  "engagementId"      TEXT NOT NULL,
  "documentVersionId" TEXT NOT NULL,
  "evidenceReference" TEXT NOT NULL,
  "evidenceHash"      TEXT NOT NULL,
  "evidenceFileName"  TEXT NOT NULL,
  "evidencePageCount" INTEGER,
  "method"            "ExternalSignatureMethod" NOT NULL,
  "signedOn"          TIMESTAMP(3) NOT NULL,
  "reason"            TEXT NOT NULL,
  "recordedBy"        TEXT,
  "recordedAt"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "karbonDocumentId"  TEXT,

  CONSTRAINT "external_signature_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "external_signature_signer" (
  "id"                  TEXT NOT NULL,
  "externalSignatureId" TEXT NOT NULL,
  "participantId"       TEXT,
  "fullLegalName"       TEXT NOT NULL,
  "role"                "ParticipantRole" NOT NULL,

  CONSTRAINT "external_signature_signer_pkey" PRIMARY KEY ("id")
);

-- The same file recorded twice against one engagement is a mistake, not a
-- second signature.
CREATE UNIQUE INDEX "external_signature_engagementId_evidenceHash_key"
  ON "external_signature"("engagementId", "evidenceHash");
CREATE INDEX "external_signature_engagementId_idx" ON "external_signature"("engagementId");

CREATE UNIQUE INDEX "external_signature_signer_externalSignatureId_participantId_key"
  ON "external_signature_signer"("externalSignatureId", "participantId");
CREATE INDEX "external_signature_signer_externalSignatureId_idx"
  ON "external_signature_signer"("externalSignatureId");

ALTER TABLE "external_signature"
  ADD CONSTRAINT "external_signature_engagementId_fkey"
  FOREIGN KEY ("engagementId") REFERENCES "engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "external_signature"
  ADD CONSTRAINT "external_signature_documentVersionId_fkey"
  FOREIGN KEY ("documentVersionId") REFERENCES "document_version"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "external_signature"
  ADD CONSTRAINT "external_signature_recordedBy_fkey"
  FOREIGN KEY ("recordedBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "external_signature_signer"
  ADD CONSTRAINT "external_signature_signer_externalSignatureId_fkey"
  FOREIGN KEY ("externalSignatureId") REFERENCES "external_signature"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "external_signature_signer"
  ADD CONSTRAINT "external_signature_signer_participantId_fkey"
  FOREIGN KEY ("participantId") REFERENCES "engagement_participant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Evidence is not optional. A signature nobody can produce the document for is
-- an assertion, not a record, and a NOT NULL column still admits the empty
-- string.
ALTER TABLE "external_signature"
  ADD CONSTRAINT "external_signature_evidence_present"
  CHECK (length(btrim("evidenceReference")) > 0 AND length(btrim("evidenceHash")) > 0);

-- A reason nobody wrote is not a reason. Same rule the wording exceptions and
-- role grants already follow.
ALTER TABLE "external_signature"
  ADD CONSTRAINT "external_signature_reason_present"
  CHECK (length(btrim("reason")) >= 10);

-- ---------------------------------------------------------------------------
-- The new transition, and the guard that keeps it narrow.
-- ---------------------------------------------------------------------------

INSERT INTO "workflow_transition" ("fromStatus", "toStatus") VALUES
  ('READY_TO_SEND', 'SIGNED')
ON CONFLICT DO NOTHING;

-- READY_TO_SEND -> SIGNED is the one transition in this workflow that turns an
-- approved document into a binding one without any vendor involved. On the
-- Adobe path the evidence is Adobe's; here there is nothing but what somebody
-- typed, so the database refuses the transition unless the evidence exists.
--
-- Enforced here rather than only in the service because this is the step that
-- would be worth faking: it is the difference between "the client agreed to
-- our fee" and "somebody said they did".
CREATE OR REPLACE FUNCTION enforce_external_signature_evidence() RETURNS trigger AS $$
BEGIN
  IF OLD."status" = 'READY_TO_SEND' AND NEW."status" = 'SIGNED' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "external_signature" WHERE "engagementId" = NEW."id"
    ) THEN
      RAISE EXCEPTION 'Cannot mark engagement % signed: no external signature evidence is recorded', NEW."id"
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER engagement_external_signature_guard
  BEFORE UPDATE ON "engagement"
  FOR EACH ROW EXECUTE FUNCTION enforce_external_signature_evidence();

-- An external signature is a record of something that already happened. It is
-- not editable for the same reason an audit event is not: the value of the
-- record is that it cannot be quietly adjusted afterwards. Correcting a mistake
-- means recording the correction, not rewriting the original.
CREATE OR REPLACE FUNCTION reject_external_signature_mutation() RETURNS trigger AS $$
BEGIN
  -- Filing into Karbon happens after the fact and is the only field a later
  -- job may fill in.
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."engagementId" IS DISTINCT FROM OLD."engagementId"
    OR NEW."documentVersionId" IS DISTINCT FROM OLD."documentVersionId"
    OR NEW."evidenceReference" IS DISTINCT FROM OLD."evidenceReference"
    OR NEW."evidenceHash" IS DISTINCT FROM OLD."evidenceHash"
    OR NEW."method" IS DISTINCT FROM OLD."method"
    OR NEW."signedOn" IS DISTINCT FROM OLD."signedOn"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."recordedBy" IS DISTINCT FROM OLD."recordedBy"
    OR NEW."recordedAt" IS DISTINCT FROM OLD."recordedAt"
  THEN
    RAISE EXCEPTION 'external_signature rows cannot be altered once recorded'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER external_signature_immutable
  BEFORE UPDATE ON "external_signature"
  FOR EACH ROW EXECUTE FUNCTION reject_external_signature_mutation();
