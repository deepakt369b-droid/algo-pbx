-- Per-tenant recording storage targets and the delivery ledger (2026-09-06).
--
-- ADDITIVE: two new tables and two new enums. No existing table is altered
-- and no existing row is touched, so this cannot affect the current flat
-- recording storage path or any tenant's ability to play back audio.
--
-- Recording.filePath semantics are NOT changed here. The move to
-- recordings/<tenantId>/ ships with its own migration script and a
-- dual-path read fallback, so the two changes can be applied and rolled
-- back independently.

CREATE TYPE "RecordingTargetKind" AS ENUM ('PLATFORM_LOCAL', 'CUSTOMER_S3', 'CUSTOMER_SFTP');
CREATE TYPE "DeliveryState" AS ENUM ('PENDING', 'IN_FLIGHT', 'DELIVERED', 'FAILED');

CREATE TABLE "RecordingStorageTarget" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "kind" "RecordingTargetKind" NOT NULL DEFAULT 'PLATFORM_LOCAL',
    -- AES-256-GCM ciphertext from src/lib/settings/crypto.ts. Credentials
    -- never land here in plaintext, and are never returned to a client.
    "configEncrypted" TEXT,
    -- Off by default: configuring a target must never silently begin
    -- shipping customer audio off-platform before it has been verified.
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "verifyBeforePurge" BOOLEAN NOT NULL DEFAULT true,
    "lastVerifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecordingStorageTarget_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RecordingStorageTarget_tenantId_key" ON "RecordingStorageTarget"("tenantId");

CREATE TABLE "RecordingDelivery" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "recordingId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "state" "DeliveryState" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    -- Kept after a later success so a flapping target stays visible instead
    -- of looking clean the moment one attempt gets through.
    "lastError" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    -- Set only once the delivered copy has been read back and matched.
    -- "verify then purge": purgedAt may never be set while this is null.
    "verifiedAt" TIMESTAMP(3),
    "purgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecordingDelivery_pkey" PRIMARY KEY ("id")
);

-- One row per recording per target. The worker upserts on this, so a retry
-- can never fan out into duplicate concurrent uploads of the same audio.
CREATE UNIQUE INDEX "RecordingDelivery_recordingId_targetId_key" ON "RecordingDelivery"("recordingId", "targetId");
CREATE INDEX "RecordingDelivery_tenantId_state_idx" ON "RecordingDelivery"("tenantId", "state");
CREATE INDEX "RecordingDelivery_state_lastAttemptAt_idx" ON "RecordingDelivery"("state", "lastAttemptAt");

ALTER TABLE "RecordingStorageTarget" ADD CONSTRAINT "RecordingStorageTarget_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "RecordingDelivery" ADD CONSTRAINT "RecordingDelivery_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- Cascade on the recording only: if a recording is hard-deleted by an admin,
-- its delivery ledger rows have nothing left to refer to. The target FK is
-- RESTRICT so a target still holding delivery history cannot be dropped.
ALTER TABLE "RecordingDelivery" ADD CONSTRAINT "RecordingDelivery_recordingId_fkey" FOREIGN KEY ("recordingId") REFERENCES "Recording"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RecordingDelivery" ADD CONSTRAINT "RecordingDelivery_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "RecordingStorageTarget"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
