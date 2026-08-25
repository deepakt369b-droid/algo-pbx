-- Workstream G — CRM connectivity: outbound webhook subscriptions and
-- machine-to-machine API keys for /api/crm/*.
--
-- Hand-written in the same style as 20260823000000_init/migration.sql and
-- for the same reason: no Postgres instance is reachable from the
-- environment this was authored in, so `prisma migrate dev` could not
-- generate the diff itself. Verify with `prisma migrate diff` against a
-- throwaway dev database before trusting it in a real deployment.
--
-- Append-only: touches no existing table. `createdById` on both tables
-- deliberately carries NO foreign key to "User" — see the schema.prisma
-- comment above model McpApproval for the shared reasoning.

-- WebhookSubscription
CREATE TABLE "WebhookSubscription" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT,
    -- Postgres text[]; Prisma maps `events String[]` to this and queries it
    -- with `has` (the `@>` containment operator).
    "events" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "WebhookSubscription_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "WebhookSubscription_active_idx" ON "WebhookSubscription"("active");
CREATE INDEX "WebhookSubscription_createdById_idx" ON "WebhookSubscription"("createdById");

-- ApiKey
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "keyHash" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ApiKey_keyHash_key" ON "ApiKey"("keyHash");
CREATE INDEX "ApiKey_revokedAt_idx" ON "ApiKey"("revokedAt");
CREATE INDEX "ApiKey_createdById_idx" ON "ApiKey"("createdById");
