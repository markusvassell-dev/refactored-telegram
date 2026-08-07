-- Working documents move from the container filesystem into Postgres.
--
-- The filesystem works on one machine. On a platform that runs the web and the
-- worker as separate services it fails silently in four places: the web uploads
-- a source document and the worker cannot read it to extract from; the worker
-- generates a PDF and the web cannot serve it to a reviewer; the web uploads a
-- template draft and the worker cannot render from it; the web records a signed
-- engagement letter and the worker cannot file it into Karbon.
--
-- A mounted volume does not fix this. Railway attaches a volume to exactly one
-- service, so a volume on each is two separate disks, and the files still do not
-- meet.
--
-- Postgres is the one store both services already share, and the only thing on
-- the platform that is backed up. Working copies are small and the purge job
-- clears them on the retention schedule.
--
-- Karbon remains the permanent home for final and signed documents.

CREATE TABLE "stored_document" (
  "reference" TEXT NOT NULL,
  "scope"     TEXT NOT NULL,
  "content"   BYTEA NOT NULL,
  "fileName"  TEXT NOT NULL,
  "mimeType"  TEXT NOT NULL,
  "byteSize"  INTEGER NOT NULL,
  "sha256"    TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expiresAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "stored_document_pkey" PRIMARY KEY ("reference")
);

CREATE INDEX "stored_document_scope_idx" ON "stored_document"("scope");
CREATE INDEX "stored_document_expiresAt_idx" ON "stored_document"("expiresAt");

-- An empty file is not a document, and a stored row with no bytes would be
-- indistinguishable from one whose upload was truncated.
ALTER TABLE "stored_document"
  ADD CONSTRAINT "stored_document_not_empty" CHECK (length("content") > 0);
