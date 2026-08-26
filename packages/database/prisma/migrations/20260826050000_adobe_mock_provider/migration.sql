-- Whether an agreement came from a mock adapter rather than from Adobe.
--
-- The Karbon filing path has drawn this distinction since August: recording a
-- mock's fabricated document id would mark a signed letter as safely filed
-- while it existed in one place only. The Adobe send never did, and it is the
-- more consequential of the two — this row is the record of a client having
-- been asked to sign something.
--
-- Distinct from `isTestMode`, which is a policy: a Test Mode send through a
-- genuine sandbox reaches a genuine Adobe account and produces a real
-- agreement. This says where the row came from.
--
-- Existing rows default to false. That is the honest answer for the ones that
-- were real, and for any that were not it is no worse than the nothing
-- recorded before this column existed.

-- AlterTable
ALTER TABLE "adobe_agreement" ADD COLUMN     "isMockProvider" BOOLEAN NOT NULL DEFAULT false;
