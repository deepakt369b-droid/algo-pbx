-- Per-extension geo allocation and lock (plan §3.3, 2026-09-08).
--
-- STRICTLY ADDITIVE. Every column on the two EXISTING tables (Tenant,
-- Extension) is nullable-or-defaulted, so:
--   * existing rows are untouched and remain valid,
--   * no table is rewritten (Postgres adds a nullable column, or a column
--     with a constant default, as a catalog-only change), so this is fast
--     even on the live Tenant/Extension tables,
--   * the migration is trivially reversible by dropping the added columns
--     and the two new tables.
--
-- Behavior is unchanged until an operator explicitly opts a tenant in:
--   * "Tenant.geoLockMode" starts NULL (= off) for every existing tenant —
--     evaluateGeoAccess() (W4) never enforces or even records for a tenant
--     in this state.
--   * "Extension.geoAllowedCountries" defaults to '{}' (unallocated) for
--     every existing extension — an unallocated extension is never locked
--     regardless of tenant mode.
--   * "Extension.geoLockedAt" starts NULL for every existing extension —
--     nothing is retroactively locked by this migration.
--
-- Two new tables, GeoLoginEvent and ExtensionUnlockRequest, carry a
-- tenantId but are DELIBERATELY NOT added to the RLS policy set created by
-- 20260904120000_add_rls. That is a considered scope decision, not an
-- oversight: that migration's own header scopes itself to the four
-- highest-value tables named in its plan (CallDetailRecord, Recording,
-- Contact, ChatMessage), and every read/write path for these two new
-- tables goes through the Prisma `$extends` tenant scoping in
-- src/lib/db-tenant.ts (registered in TENANT_SCOPED_MODELS /
-- TENANCY_TABLES — see src/lib/tenancy/scope-rules.ts and
-- scripts/lib/tenancy-tables.ts) the same as every other tenant-owned
-- model added since that migration landed. Adding RLS here would need its
-- own GUC-discipline review (see that migration's three preconditions) for
-- two tables that are, respectively, an append-only audit trail and a
-- small owner-facing queue — lower marginal value than the four tables
-- already covered. Revisit if either table ever grows a direct
-- $queryRaw/$executeRaw access path.

-- --- Tenant: geo-lock mode + tenant-level defaults -------------------------
ALTER TABLE "Tenant" ADD COLUMN "geoLockMode" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "geoDefaultCountry" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "geoBlockVpn" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Tenant" ADD COLUMN "geoFailureThreshold" INTEGER;

-- --- Extension: allocation, strike counters, the lock itself --------------
ALTER TABLE "Extension" ADD COLUMN "geoAllowedCountries" TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE "Extension" ADD COLUMN "geoFailedAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Extension" ADD COLUMN "geoLastFailureAt" TIMESTAMP(3);
ALTER TABLE "Extension" ADD COLUMN "geoLastFailureCountry" TEXT;
ALTER TABLE "Extension" ADD COLUMN "geoLastFailureIp" TEXT;
ALTER TABLE "Extension" ADD COLUMN "geoLastFailureAsn" INTEGER;
-- Non-NULL means locked, with no expiry — this column IS the lock. See
-- Extension.geoLockedAt's doc comment in schema.prisma for why
-- LoginAttempt.lockedUntil's time-expiring shape was deliberately not
-- reused here.
ALTER TABLE "Extension" ADD COLUMN "geoLockedAt" TIMESTAMP(3);
ALTER TABLE "Extension" ADD COLUMN "geoLockedReason" TEXT;
ALTER TABLE "Extension" ADD COLUMN "geoUnlockedAt" TIMESTAMP(3);
ALTER TABLE "Extension" ADD COLUMN "geoUnlockedByPlatformUserId" TEXT;

-- --- GeoLoginEvent: the evidence trail an owner reads before unlocking -----
CREATE TABLE "GeoLoginEvent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "extensionId" TEXT,
    "userId" TEXT,
    "email" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "country" TEXT,
    "asn" INTEGER,
    "asnOrg" TEXT,
    "outcome" TEXT NOT NULL,
    "counted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeoLoginEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "GeoLoginEvent_tenantId_createdAt_idx" ON "GeoLoginEvent"("tenantId", "createdAt");
CREATE INDEX "GeoLoginEvent_extensionId_createdAt_idx" ON "GeoLoginEvent"("extensionId", "createdAt");

ALTER TABLE "GeoLoginEvent" ADD CONSTRAINT "GeoLoginEvent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GeoLoginEvent" ADD CONSTRAINT "GeoLoginEvent_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- ExtensionUnlockRequest: the tenant side's only lever ------------------
CREATE TABLE "ExtensionUnlockRequest" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "requestedReason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "resolvedByPlatformUserId" TEXT,
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "ExtensionUnlockRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ExtensionUnlockRequest_status_createdAt_idx" ON "ExtensionUnlockRequest"("status", "createdAt");
CREATE INDEX "ExtensionUnlockRequest_tenantId_idx" ON "ExtensionUnlockRequest"("tenantId");

ALTER TABLE "ExtensionUnlockRequest" ADD CONSTRAINT "ExtensionUnlockRequest_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ExtensionUnlockRequest" ADD CONSTRAINT "ExtensionUnlockRequest_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Partial unique index: at most one PENDING unlock request per extension at
-- a time. Prisma's schema language has no way to express a WHERE-qualified
-- unique index, so this is hand-added here rather than generated —
-- enforced as defense-in-depth alongside the route-level check in
-- POST /api/admin/extension-unlock-requests.
CREATE UNIQUE INDEX "ExtensionUnlockRequest_one_pending_per_extension" ON "ExtensionUnlockRequest" ("extensionId") WHERE status = 'PENDING';
