-- Caller-ID routing rules — independently designed (2026-09-14), no
-- third-party code or schema reused. See prisma/schema.prisma's own header
-- comment on CallerRoutingRule for the full design rationale.
--
-- STRICTLY ADDITIVE: a new enum and a new tenant-scoped table, same shape
-- of thought as DoNotCallEntry (tenant + pattern, composite unique) but
-- with three possible actions instead of an implicit single one.

CREATE TYPE "CallerRoutingAction" AS ENUM ('PASS', 'BLOCK', 'AI');

CREATE TABLE "CallerRoutingRule" (
    "id"        TEXT NOT NULL,
    "tenantId"  TEXT NOT NULL,
    "pattern"   TEXT NOT NULL,
    "action"    "CallerRoutingAction" NOT NULL,
    "note"      TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallerRoutingRule_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CallerRoutingRule_tenantId_pattern_key" ON "CallerRoutingRule"("tenantId", "pattern");
CREATE INDEX "CallerRoutingRule_tenantId_idx" ON "CallerRoutingRule"("tenantId");

ALTER TABLE "CallerRoutingRule" ADD CONSTRAINT "CallerRoutingRule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
