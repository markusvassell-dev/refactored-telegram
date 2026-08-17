-- What Karbon calls a client, kept rather than discarded.
--
-- The import splits Karbon's FullName — "2409116 Alberta Ltd. (Lava Grill
-- Seton)" — because the numbered company is the entity that signs an engagement
-- letter, and stores only the halves. For a client already here under the wrong
-- name that lost the answer: the import will not overwrite an existing legal
-- name, so it reported the difference once and moved on, and nothing afterwards
-- could say what Karbon actually calls the client.
--
-- These three columns are a mirror of the vendor rather than firm-entered data,
-- which is why the import refreshes them on every run instead of only filling
-- them when empty. "Never overwrite" exists to protect a value somebody chose;
-- nobody chose this one.

-- AlterTable
ALTER TABLE "client" ADD COLUMN     "karbonFullName" TEXT,
ADD COLUMN     "karbonContactType" TEXT,
ADD COLUMN     "karbonNameSyncedAt" TIMESTAMP(3);

-- Looking a client up by the name Karbon knows is the point of the column.
-- CreateIndex
CREATE INDEX "client_karbonFullName_idx" ON "client"("karbonFullName");
