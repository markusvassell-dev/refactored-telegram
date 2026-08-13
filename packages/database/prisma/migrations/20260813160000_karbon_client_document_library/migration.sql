-- The catalogue behind a client's Karbon Documents tab.
--
-- Metadata only, deliberately. Karbon issues a download token alongside a file
-- listing and it expires in about fifteen minutes, so a stored URL is a link
-- that works while you are testing it and fails for the first person who opens
-- it an hour later. Selecting a document fetches a fresh listing instead.

-- CreateTable
CREATE TABLE "karbon_client_document" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "karbonFileKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "sourceEntityType" TEXT NOT NULL,
    "sourceEntityKey" TEXT NOT NULL,
    "sourceLabel" TEXT NOT NULL,
    "byteSize" INTEGER,
    "mimeType" TEXT,
    "uploadedAt" TIMESTAMP(3),
    "inferredTaxYear" INTEGER,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "karbon_client_document_pkey" PRIMARY KEY ("id")
);

-- The outcome of one attempt to read a client's whole library. A document count
-- on its own cannot be trusted: 91 from a complete read and 91 from a read that
-- lost two work items to a timeout are different answers, and only this tells
-- them apart.
-- CreateTable
CREATE TABLE "karbon_library_sync" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "scopesRead" INTEGER NOT NULL DEFAULT 0,
    "scopesFailed" INTEGER NOT NULL DEFAULT 0,
    "documentsFound" INTEGER NOT NULL DEFAULT 0,
    "documentsNew" INTEGER NOT NULL DEFAULT 0,
    "complete" BOOLEAN NOT NULL DEFAULT false,
    "failureDetail" JSONB,

    CONSTRAINT "karbon_library_sync_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "karbon_client_document_clientId_uploadedAt_idx" ON "karbon_client_document"("clientId", "uploadedAt");

-- CreateIndex
CREATE INDEX "karbon_client_document_clientId_inferredTaxYear_idx" ON "karbon_client_document"("clientId", "inferredTaxYear");

-- CreateIndex
CREATE UNIQUE INDEX "karbon_client_document_clientId_karbonFileKey_key" ON "karbon_client_document"("clientId", "karbonFileKey");

-- CreateIndex
CREATE INDEX "karbon_library_sync_clientId_startedAt_idx" ON "karbon_library_sync"("clientId", "startedAt");

-- AddForeignKey
ALTER TABLE "karbon_client_document" ADD CONSTRAINT "karbon_client_document_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "karbon_library_sync" ADD CONSTRAINT "karbon_library_sync_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
