-- Manager escalation (Loop C1). Hand-written, same caveat as every other
-- migration in this repo: no reachable Postgres to diff against in this
-- environment — verify with `prisma migrate diff` before trusting as a
-- deploy baseline. Append-only: touches no existing table.

-- CreateEnum
CREATE TYPE "EscalationOutcome" AS ENUM ('ANSWERED', 'BUSY', 'NO_ANSWER', 'FAILED', 'UNKNOWN');

-- CreateTable
CREATE TABLE "EscalationTarget" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "extension" TEXT,
    "phoneE164" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT,
    CONSTRAINT "EscalationTarget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EscalationAttempt" (
    "id" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "targetId" TEXT,
    "targetName" TEXT NOT NULL,
    "outcome" "EscalationOutcome" NOT NULL DEFAULT 'UNKNOWN',
    "waNotified" BOOLEAN NOT NULL DEFAULT false,
    "waError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    CONSTRAINT "EscalationAttempt_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EscalationAttempt_agentId_idx" ON "EscalationAttempt"("agentId");
CREATE INDEX "EscalationAttempt_targetId_idx" ON "EscalationAttempt"("targetId");
CREATE INDEX "EscalationAttempt_createdAt_idx" ON "EscalationAttempt"("createdAt");

-- AddForeignKey
ALTER TABLE "EscalationAttempt" ADD CONSTRAINT "EscalationAttempt_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "EscalationAttempt" ADD CONSTRAINT "EscalationAttempt_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "EscalationTarget"("id") ON DELETE SET NULL ON UPDATE CASCADE;
