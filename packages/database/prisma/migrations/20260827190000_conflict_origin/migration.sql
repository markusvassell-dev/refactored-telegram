-- Telling a disagreement between *sources* from one between *documents*.
--
-- `reconcile` clears an unresolved conflict for a token once the sources it can
-- see agree. A scan that reads a client's whole library produces a different
-- kind of disagreement: two documents saying different things under one source.
-- Undistinguished, the scan's question is deleted the moment Karbon happens to
-- agree with whichever document won — and a decision somebody still had to make
-- disappears with no trace.
--
-- Defaulted, so every existing row is already correct and no backfill is needed.
CREATE TYPE "ConflictOrigin" AS ENUM ('CROSS_SOURCE', 'CROSS_DOCUMENT');

ALTER TABLE "field_conflict"
  ADD COLUMN "origin" "ConflictOrigin" NOT NULL DEFAULT 'CROSS_SOURCE';
