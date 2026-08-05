-- The audit trail must outlive the records it describes.
--
-- A foreign key with ON DELETE SET NULL performs an UPDATE on audit_event,
-- which the immutability trigger correctly refuses. That made deleting any
-- engagement or user impossible. Dropping the constraints keeps the recorded
-- identifiers intact for ever, which is what an audit trail is for.

ALTER TABLE "audit_event" DROP CONSTRAINT IF EXISTS "audit_event_userId_fkey";
ALTER TABLE "audit_event" DROP CONSTRAINT IF EXISTS "audit_event_engagementId_fkey";
