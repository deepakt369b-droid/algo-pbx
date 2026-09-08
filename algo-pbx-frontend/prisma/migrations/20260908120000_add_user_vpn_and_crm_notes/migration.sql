-- Per-user VPN profiles + CRM threaded notes (owner-page enchanted-sphinx
-- plan, G0, 2026-09-08).
--
-- STRICTLY ADDITIVE: two new tables and one new nullable column on an
-- existing table (ContactTask). No existing row is touched.
--
--   * UserVpnProfile is a 1:1 profile per tenant User (userId UNIQUE),
--     distinct from GatewaySite (per-tenant gateway tunnel). Administered
--     only from the tenant admin console — the route guard
--     (requireAdminSession(), not the nav) is what keeps it out of the
--     agent console. Reuses the existing SiteTransport /
--     SiteConnectivityStatus enums; configEncrypted is at rest via the
--     existing src/lib/settings/crypto.ts scheme, same as
--     GatewaySite.configEncrypted — not a new encryption scheme.
--   * CompanyNote is an exact structural mirror of the existing DealNote
--     table. Company notes have no Activity column to hang on (Activity
--     has no companyId); the API layer attaches the accompanying Activity
--     row to the company's primary contact when one exists and writes
--     only the note when it doesn't (see
--     src/app/api/admin/crm/companies/[id]/notes/route.ts's header).
--   * ContactTask.description is a new nullable text column — existing
--     tasks keep description = NULL and remain fully valid.
--
-- Both new tables carry a tenantId and are added to TENANT_SCOPED_MODELS /
-- TENANCY_TABLES (src/lib/tenancy/scope-rules.ts,
-- scripts/lib/tenancy-tables.ts) so they are scoped by the Prisma
-- `$extends` tenant client like every other tenant-owned model. Neither is
-- added to the RLS policy set from 20260904120000_add_rls — that migration
-- scopes itself to its four highest-value tables (CallDetailRecord,
-- Recording, Contact, ChatMessage); these two are lower marginal value
-- (a 1:1 VPN profile and a small notes table), the same considered-scope
-- reasoning as 20260908100000_add_extension_geo_lock's header. Revisit if
-- either ever grows a direct $queryRaw/$executeRaw access path.

-- --- ContactTask: notes/description -----------------------------------
ALTER TABLE "ContactTask" ADD COLUMN "description" TEXT;

-- --- UserVpnProfile -----------------------------------------------------
CREATE TABLE "UserVpnProfile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "transport" "SiteTransport" NOT NULL DEFAULT 'WIREGUARD',
    "label" TEXT,
    "tunnelIp" TEXT,
    "publicKey" TEXT,
    "configEncrypted" TEXT,
    "status" "SiteConnectivityStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastHandshakeAt" TIMESTAMP(3),
    "lastReachableAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserVpnProfile_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "UserVpnProfile_userId_key" ON "UserVpnProfile"("userId");
CREATE INDEX "UserVpnProfile_tenantId_idx" ON "UserVpnProfile"("tenantId");

ALTER TABLE "UserVpnProfile" ADD CONSTRAINT "UserVpnProfile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "UserVpnProfile" ADD CONSTRAINT "UserVpnProfile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- --- CompanyNote (mirrors DealNote) -------------------------------------
CREATE TABLE "CompanyNote" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyNote_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CompanyNote_companyId_idx" ON "CompanyNote"("companyId");
CREATE INDEX "CompanyNote_tenantId_idx" ON "CompanyNote"("tenantId");

ALTER TABLE "CompanyNote" ADD CONSTRAINT "CompanyNote_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CompanyNote" ADD CONSTRAINT "CompanyNote_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CompanyNote" ADD CONSTRAINT "CompanyNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
