-- Something a person needs to know about, addressed to one person.
--
-- The application changed state silently: a client signed, the engagement
-- advanced, documents were filed, and nobody was told.

CREATE TABLE "notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "link" TEXT,
    "engagementId" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- The unread list, newest first, is the query this table exists to serve.
CREATE INDEX "notification_userId_readAt_createdAt_idx"
    ON "notification"("userId", "readAt", "createdAt");

ALTER TABLE "notification" ADD CONSTRAINT "notification_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "notification" ADD CONSTRAINT "notification_engagementId_fkey"
    FOREIGN KEY ("engagementId") REFERENCES "engagement"("id") ON DELETE CASCADE ON UPDATE CASCADE;
