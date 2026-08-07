-- Email delivery, tracked separately from the notice itself. An in-app notice
-- that could not be emailed is still a notice.

ALTER TABLE "notification" ADD COLUMN "emailedAt" TIMESTAMP(3);
ALTER TABLE "notification" ADD COLUMN "emailError" TEXT;
ALTER TABLE "notification" ADD COLUMN "emailAttempts" INTEGER NOT NULL DEFAULT 0;

-- The drain query: never emailed, not yet given up on, oldest first.
CREATE INDEX "notification_emailedAt_emailAttempts_createdAt_idx"
    ON "notification"("emailedAt", "emailAttempts", "createdAt");
