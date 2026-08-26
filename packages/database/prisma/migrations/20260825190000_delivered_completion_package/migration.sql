-- Delivering the completion package into the client's own Karbon Documents tab.
--
-- `READY_FOR_DELIVERY` was the end of the road: an approved cover letter sat
-- there and nothing consumed it. The T2 return and the financial statements
-- reached Karbon by no path at all, so "the client's file is complete" was a
-- thing the application could describe and not a thing it could do.
--
-- DELIVERED is the state after the files are actually in Karbon. It is
-- deliberately not undone by a stale source document: the documents are in the
-- client's records and this application cannot unsend them. What a stale source
-- does is send the engagement back to COVER_LETTER_CHANGES_REQUESTED so it
-- stops reading as finished until somebody regenerates and approves again.
--
-- The transitions that use these values are in the migration immediately after
-- this one, and they have to be: Postgres refuses to *use* a new enum value in
-- the transaction that added it.

-- AlterEnum
ALTER TYPE "EngagementStatus" ADD VALUE 'DELIVERED';

-- AlterEnum
ALTER TYPE "CoverLetterStatus" ADD VALUE 'DELIVERED';

-- What went to Karbon and under which file id. Recorded rather than assumed:
-- an upload reporting success against a mock adapter has filed nothing, and a
-- package with no file ids is how a later reader can tell the difference.
-- AlterTable
ALTER TABLE "cover_letter_package" ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "karbonFileIds" JSONB;
