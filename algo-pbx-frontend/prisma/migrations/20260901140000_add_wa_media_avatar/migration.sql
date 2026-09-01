-- WhatsApp media + profile-picture + history-sync support (2026-09-01).
--
-- Generated via `prisma migrate diff --from-migrations ... --to-schema-datamodel
-- ... --shadow-database-url <throwaway>` against a shadow DB on production
-- Postgres, then hand-trimmed to drop the unrelated
-- `DROP INDEX "Recording_hiddenFromAgentAt_idx"` (pre-existing schema/DB drift,
-- same as every 2026083*/2026090* migration). Additive only.

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN     "mediaKind" TEXT,
ADD COLUMN     "waMessageId" TEXT;

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "waAvatarCheckedAt" TIMESTAMP(3),
ADD COLUMN     "waAvatarUrl" TEXT;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "historySyncedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ChatMessage_waMessageId_idx" ON "ChatMessage"("waMessageId");
