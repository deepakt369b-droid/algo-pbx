-- Binds WaInstance to a real OpenWA session (the previous adapter called
-- an invented API surface that never returned a QR — see
-- src/lib/messaging/openwa-client.ts and openwa-types.ts) and adds
-- one-agent-per-SIM-port ownership, distinct from the existing
-- pairedByAdminId audit stamp.
--
-- All new columns are nullable with no defaults — additive only, no table
-- rewrite, safe against the live single-row WaInstance table.

-- AlterTable
ALTER TABLE "WaInstance" ADD COLUMN     "sessionName" TEXT,
ADD COLUMN     "openwaSessionId" TEXT,
ADD COLUMN     "providerStatusRaw" TEXT,
ADD COLUMN     "pushName" TEXT,
ADD COLUMN     "lastError" TEXT,
ADD COLUMN     "lastStatusAt" TIMESTAMP(3),
ADD COLUMN     "lastQrCode" TEXT,
ADD COLUMN     "lastQrAt" TIMESTAMP(3),
ADD COLUMN     "pairingCode" TEXT,
ADD COLUMN     "pairingCodeAt" TIMESTAMP(3),
ADD COLUMN     "webhookRegisteredAt" TIMESTAMP(3),
ADD COLUMN     "assignedUserId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "WaInstance_sessionName_key" ON "WaInstance"("sessionName");

-- CreateIndex
CREATE UNIQUE INDEX "WaInstance_openwaSessionId_key" ON "WaInstance"("openwaSessionId");

-- CreateIndex
CREATE UNIQUE INDEX "WaInstance_assignedUserId_key" ON "WaInstance"("assignedUserId");

-- AddForeignKey
ALTER TABLE "WaInstance" ADD CONSTRAINT "WaInstance_assignedUserId_fkey" FOREIGN KEY ("assignedUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "InboundWebhookDelivery" (
    "id" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "deliveryId" TEXT,
    "event" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InboundWebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InboundWebhookDelivery_idempotencyKey_key" ON "InboundWebhookDelivery"("idempotencyKey");

-- CreateIndex
CREATE INDEX "InboundWebhookDelivery_receivedAt_idx" ON "InboundWebhookDelivery"("receivedAt");

-- Backfill: the one WaInstance row that predates this binding is a ghost
-- (created against the old, invented API surface — it can never have a
-- real openwaSessionId). Mark it DISCONNECTED with a clear lastError
-- rather than leaving it stuck in PAIRING forever in the new UI.
UPDATE "WaInstance"
SET "status" = 'DISCONNECTED',
    "lastError" = 'Re-pair required: created before OpenWA session binding existed.'
WHERE "openwaSessionId" IS NULL;
