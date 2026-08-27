-- One run of the client-document scan.
--
-- Written before the work starts and finished at the end, so a scan the worker
-- died in the middle of leaves an unfinished row rather than nothing at all.
--
-- `complete` is the load-bearing column: ninety-one documents from a complete
-- read and ninety-one from a read that lost two scopes to a timeout are not the
-- same answer, and the difference is what decides whether "this client has no
-- prior-year letter" means anything.
CREATE TABLE "source_document_scan" (
  "id"                  TEXT NOT NULL,
  "engagementId"        TEXT NOT NULL,
  "startedAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finishedAt"          TIMESTAMP(3),
  "documentsCatalogued" INTEGER NOT NULL DEFAULT 0,
  "documentsConsidered" INTEGER NOT NULL DEFAULT 0,
  "documentsRead"       INTEGER NOT NULL DEFAULT 0,
  "documentsUnreadable" INTEGER NOT NULL DEFAULT 0,
  "documentsAccepted"   INTEGER NOT NULL DEFAULT 0,
  "tokensFilled"        INTEGER NOT NULL DEFAULT 0,
  "conflictsRaised"     INTEGER NOT NULL DEFAULT 0,
  "scopesRead"          INTEGER NOT NULL DEFAULT 0,
  "scopesFailed"        INTEGER NOT NULL DEFAULT 0,
  "complete"            BOOLEAN NOT NULL DEFAULT false,
  "cappedAt"            INTEGER,
  "failureDetail"       JSONB,

  CONSTRAINT "source_document_scan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "source_document_scan_engagementId_startedAt_idx"
  ON "source_document_scan"("engagementId", "startedAt");

ALTER TABLE "source_document_scan"
  ADD CONSTRAINT "source_document_scan_engagementId_fkey"
  FOREIGN KEY ("engagementId") REFERENCES "engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
