-- Feature B3 (2026-08-31) — one-contact-one-owner conflict resolution.
-- Generated via `prisma migrate diff --from-url $DATABASE_URL --to-schema-
-- datamodel prisma/schema.prisma --script` run inside the live algo-web
-- container against the real production DB, per DEPLOYMENT.md's
-- no-local-dev-DB migration workflow. NOT applied by this session — the
-- reviewer runs `prisma migrate deploy` (or applies this file directly).
--
-- NOTE: the raw diff output also included `DROP INDEX
-- "Recording_hiddenFromAgentAt_idx"` — pre-existing drift between the live
-- DB and the currently-committed schema.prisma (that index exists in prod
-- but no `@@index` for it exists in schema.prisma today), unrelated to this
-- feature. Deliberately NOT included below — bundling an unrelated
-- production index drop into a CRM-ownership migration would be a scope
-- overreach; flagging it in the session report for separate handling.

-- CreateEnum
CREATE TYPE "ContactTransferRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED');

-- CreateTable
CREATE TABLE "ContactTransferRequest" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "currentOwnerId" TEXT NOT NULL,
    "status" "ContactTransferRequestStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactTransferRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContactTransferRequest_status_idx" ON "ContactTransferRequest"("status");

-- CreateIndex
CREATE INDEX "ContactTransferRequest_contactId_idx" ON "ContactTransferRequest"("contactId");

-- CreateIndex
CREATE INDEX "ContactTransferRequest_requestedById_idx" ON "ContactTransferRequest"("requestedById");

-- CreateIndex
CREATE INDEX "ContactTransferRequest_currentOwnerId_idx" ON "ContactTransferRequest"("currentOwnerId");

-- AddForeignKey
ALTER TABLE "ContactTransferRequest" ADD CONSTRAINT "ContactTransferRequest_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactTransferRequest" ADD CONSTRAINT "ContactTransferRequest_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactTransferRequest" ADD CONSTRAINT "ContactTransferRequest_currentOwnerId_fkey" FOREIGN KEY ("currentOwnerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactTransferRequest" ADD CONSTRAINT "ContactTransferRequest_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
