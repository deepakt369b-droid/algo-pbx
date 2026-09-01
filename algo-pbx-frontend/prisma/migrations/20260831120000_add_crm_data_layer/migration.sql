-- P2 CRM data layer (LLM.md §28/§29): ContactNote, ContactTask,
-- CallDisposition, plus Contact += email/company/tags/ownerId and
-- CallDetailRecord += callerNumberE164 (normalized, indexed).
--
-- Generated via `prisma migrate diff --from-url ... --to-schema-datamodel`
-- against live production, then hand-trimmed to remove one unrelated line
-- the diff also produced (`DROP INDEX "Recording_hiddenFromAgentAt_idx"`)
-- — pre-existing drift between schema.prisma and migration history,
-- unrelated to this change, not touched here.

-- CreateEnum
CREATE TYPE "CallDispositionOutcome" AS ENUM ('INTERESTED', 'CALLBACK', 'NOT_INTERESTED', 'DNC');

-- AlterTable
ALTER TABLE "CallDetailRecord" ADD COLUMN     "callerNumberE164" TEXT;

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "company" TEXT,
ADD COLUMN     "email" TEXT,
ADD COLUMN     "ownerId" TEXT,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "ContactNote" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContactTask" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "assigneeId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallDisposition" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "cdrUniqueId" TEXT,
    "outcome" "CallDispositionOutcome" NOT NULL,
    "note" TEXT,
    "agentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallDisposition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContactNote_contactId_idx" ON "ContactNote"("contactId");

-- CreateIndex
CREATE INDEX "ContactTask_contactId_idx" ON "ContactTask"("contactId");

-- CreateIndex
CREATE INDEX "ContactTask_assigneeId_idx" ON "ContactTask"("assigneeId");

-- CreateIndex
CREATE INDEX "CallDisposition_contactId_idx" ON "CallDisposition"("contactId");

-- CreateIndex
CREATE INDEX "CallDetailRecord_callerNumberE164_idx" ON "CallDetailRecord"("callerNumberE164");

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactNote" ADD CONSTRAINT "ContactNote_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactNote" ADD CONSTRAINT "ContactNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactTask" ADD CONSTRAINT "ContactTask_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactTask" ADD CONSTRAINT "ContactTask_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallDisposition" ADD CONSTRAINT "CallDisposition_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallDisposition" ADD CONSTRAINT "CallDisposition_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
