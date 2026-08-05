-- Cover letter narrative edits.
--
-- The narrative is the one part of a cover letter meant to be written rather
-- than derived. `sectionKey` matches a key the template manifest lists in
-- `editableSections`, so the approved legal wording around it cannot be reached
-- through this table.
--
-- Edits are never overwritten: a new edit supersedes the previous row, and the
-- partial unique index keeps exactly one live edit per section. "What did this
-- letter say when it was approved" stays answerable.

CREATE TABLE "cover_letter_narrative" (
    "id" TEXT NOT NULL,
    "coverLetterPackageId" TEXT NOT NULL,
    "sectionKey" TEXT NOT NULL,
    "originalText" TEXT NOT NULL,
    "editedText" TEXT NOT NULL,
    "templateVersionId" TEXT,
    "reason" TEXT,
    "authorUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "cover_letter_narrative_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cover_letter_narrative_coverLetterPackageId_sectionKey_idx"
  ON "cover_letter_narrative" ("coverLetterPackageId", "sectionKey");

-- One live edit per section, enforced by the database rather than by whichever
-- code path happens to write next.
CREATE UNIQUE INDEX "cover_letter_narrative_one_live_per_section"
  ON "cover_letter_narrative" ("coverLetterPackageId", "sectionKey")
  WHERE "supersededAt" IS NULL;

ALTER TABLE "cover_letter_narrative"
  ADD CONSTRAINT "cover_letter_narrative_coverLetterPackageId_fkey"
  FOREIGN KEY ("coverLetterPackageId") REFERENCES "cover_letter_package"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "cover_letter_narrative"
  ADD CONSTRAINT "cover_letter_narrative_templateVersionId_fkey"
  FOREIGN KEY ("templateVersionId") REFERENCES "template_version"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- The author is never deleted out from under the record.
ALTER TABLE "cover_letter_narrative"
  ADD CONSTRAINT "cover_letter_narrative_authorUserId_fkey"
  FOREIGN KEY ("authorUserId") REFERENCES "user"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- An edit is a revision, not a correction of history. Superseding a live edit is
-- allowed; rewriting what any edit said is not. Without this, "the letter the
-- partner approved said X" is a claim the database cannot stand behind.
CREATE OR REPLACE FUNCTION cover_letter_narrative_no_rewrite()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD."supersededAt" IS NOT NULL THEN
    RAISE EXCEPTION
      'A superseded narrative edit cannot be changed; it is the record of what the letter said.';
  END IF;

  -- Retiring a live edit is the only permitted update. Listing what may change
  -- rather than what may not means a column added later is locked by default.
  IF NEW."id"                   IS DISTINCT FROM OLD."id"
     OR NEW."coverLetterPackageId" IS DISTINCT FROM OLD."coverLetterPackageId"
     OR NEW."sectionKey"        IS DISTINCT FROM OLD."sectionKey"
     OR NEW."originalText"      IS DISTINCT FROM OLD."originalText"
     OR NEW."editedText"        IS DISTINCT FROM OLD."editedText"
     OR NEW."templateVersionId" IS DISTINCT FROM OLD."templateVersionId"
     OR NEW."reason"            IS DISTINCT FROM OLD."reason"
     OR NEW."authorUserId"      IS DISTINCT FROM OLD."authorUserId"
     OR NEW."createdAt"         IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION
      'A narrative edit cannot be rewritten in place. Supersede it with a new edit instead.';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cover_letter_narrative_no_rewrite_trigger
  BEFORE UPDATE ON "cover_letter_narrative"
  FOR EACH ROW EXECUTE FUNCTION cover_letter_narrative_no_rewrite();

-- Deliberately no delete trigger. This table is working state belonging to a
-- cover letter package, and deleting the package should take its drafts with it.
-- The permanent record of who changed the wording and why lives in audit_event,
-- which no code path can delete.
