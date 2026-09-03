-- Dinstar "Remote Server" (syslog) ingest (2026-09-03). Hand-authored —
-- mirrors Prisma's standard generated shape for two new enums plus one new
-- additive table; not run against a live shadow DB from this environment
-- (Postgres is VPS-only, loopback-bound, per this repo's existing
-- convention — see LLM.md's P2 section). MUST be verified with
-- `prisma migrate deploy` against the real container, and the deploy
-- output MUST name this migration explicitly — "No pending migrations"
-- there is a failure, not a pass (the same lesson recorded after the P2
-- session's caller-E164 backfill).

-- CreateEnum
CREATE TYPE "GatewaySeverity" AS ENUM ('EMERG', 'ALERT', 'CRIT', 'ERROR', 'WARNING', 'NOTICE', 'INFO', 'DEBUG');

-- CreateEnum
CREATE TYPE "GatewayCategory" AS ENUM ('GSM', 'SIP', 'VPN', 'SYSTEM', 'RAW');

-- CreateTable
CREATE TABLE "GatewayEvent" (
    "id" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deviceTime" TIMESTAMP(3),
    "siteId" TEXT,
    "sourceIp" TEXT,
    "severity" "GatewaySeverity" NOT NULL,
    "category" "GatewayCategory" NOT NULL,
    "eventType" TEXT,
    "port" INTEGER,
    "message" TEXT NOT NULL,
    "raw" TEXT NOT NULL,

    CONSTRAINT "GatewayEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GatewayEvent_receivedAt_idx" ON "GatewayEvent"("receivedAt");

-- CreateIndex
CREATE INDEX "GatewayEvent_category_receivedAt_idx" ON "GatewayEvent"("category", "receivedAt");

-- CreateIndex
CREATE INDEX "GatewayEvent_eventType_receivedAt_idx" ON "GatewayEvent"("eventType", "receivedAt");
