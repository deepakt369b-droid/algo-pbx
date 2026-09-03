-- OpenVPN-primary / Headscale-fallback / Tailscale-legacy gateway
-- connectivity tracking (2026-09-03). Hand-authored — mirrors Prisma's
-- standard generated shape for two new enums, one new additive table, and
-- one new nullable FK on the existing GatewayEvent table; not run against a
-- live shadow DB from this environment (Postgres is VPS-only,
-- loopback-bound, per this repo's existing convention — see LLM.md's P2
-- section). MUST be verified with `prisma migrate deploy` against the real
-- container, and the deploy output MUST name this migration explicitly —
-- "No pending migrations" there is a failure, not a pass (the same lesson
-- recorded after the P2 session's caller-E164 backfill, and again for the
-- gateway_event migration this session).

-- CreateEnum
CREATE TYPE "SiteTransport" AS ENUM ('TAILSCALE', 'OPENVPN', 'HEADSCALE');

-- CreateEnum
CREATE TYPE "SiteConnectivityStatus" AS ENUM ('UNKNOWN', 'UP', 'DEGRADED', 'DOWN');

-- CreateTable
CREATE TABLE "GatewaySite" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "gatewayLanIp" TEXT NOT NULL,
    "tunnelIp" TEXT,
    "transport" "SiteTransport" NOT NULL DEFAULT 'TAILSCALE',
    "headscaleNodeKey" TEXT,
    "lastHandshakeAt" TIMESTAMP(3),
    "lastReachableAt" TIMESTAMP(3),
    "status" "SiteConnectivityStatus" NOT NULL DEFAULT 'UNKNOWN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GatewaySite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "GatewaySite_name_key" ON "GatewaySite"("name");

-- CreateIndex
CREATE INDEX "GatewaySite_status_idx" ON "GatewaySite"("status");

-- CreateIndex
CREATE INDEX "GatewayEvent_siteId_receivedAt_idx" ON "GatewayEvent"("siteId", "receivedAt");

-- AddForeignKey
ALTER TABLE "GatewayEvent" ADD CONSTRAINT "GatewayEvent_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "GatewaySite"("id") ON DELETE SET NULL ON UPDATE CASCADE;
