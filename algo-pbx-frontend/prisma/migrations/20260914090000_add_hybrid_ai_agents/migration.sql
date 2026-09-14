-- Premium "Hybrid AI + Human" plan (LLM.md decision, 2026-09-14).
--
-- STRICTLY ADDITIVE except one default change:
--   * Tenant.seats default 5 -> 4. Existing rows are NOT rewritten by this
--     migration (ALTER COLUMN ... SET DEFAULT only changes future INSERTs);
--     an already-provisioned tenant keeps whatever seat count it has today.
--   * Extension gets a new "agentType" column, default 'HUMAN', backfilling
--     every existing row to 'HUMAN' (correct: no AI extensions exist yet).
--   * Three new tables: AiAgent (1:1 with an AI-kind Extension),
--     AiProviderCredential (per-tenant provider keys, encrypted with the
--     existing src/lib/settings/crypto.ts AES-256-GCM scheme — not a new
--     encryption scheme), and AiCallSession (one row per AI-handled call,
--     linked to CallDetailRecord by uniqueId rather than an FK — see
--     schema.prisma's comment on AiCallSession for why).
--
-- All three new tables carry a tenantId and are added to
-- TENANT_SCOPED_MODELS / TENANCY_TABLES (src/lib/tenancy/scope-rules.ts,
-- scripts/lib/tenancy-tables.ts) so they are scoped by the Prisma
-- `$extends` tenant client like every other tenant-owned model. None are
-- added to the RLS policy set from 20260904120000_add_rls — same
-- considered-scope reasoning as 20260908100000_add_extension_geo_lock's
-- header (lower marginal value than CallDetailRecord/Recording/Contact/
-- ChatMessage; revisit if a direct $queryRaw/$executeRaw path appears).

-- --- Tenant.seats default -------------------------------------------------
ALTER TABLE "Tenant" ALTER COLUMN "seats" SET DEFAULT 4;

-- --- Extension.agentType ---------------------------------------------------
ALTER TABLE "Extension" ADD COLUMN "agentType" TEXT NOT NULL DEFAULT 'HUMAN';

-- --- AiAgent ----------------------------------------------------------------
CREATE TABLE "AiAgent" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "extensionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "greeting" TEXT NOT NULL,
    "systemPrompt" TEXT NOT NULL,
    "pipelineMode" TEXT NOT NULL DEFAULT 'CASCADE',
    "realtimeProviderId" TEXT,
    "realtimeModel" TEXT,
    "sttProviderId" TEXT,
    "sttModel" TEXT,
    "llmProviderId" TEXT,
    "llmModel" TEXT,
    "ttsProviderId" TEXT,
    "ttsModel" TEXT,
    "ttsVoice" TEXT,
    "tools" JSONB,
    "allowedDestinations" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "callHoursStart" INTEGER,
    "callHoursEnd" INTEGER,
    "outboundEnabled" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiAgent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiAgent_extensionId_key" ON "AiAgent"("extensionId");
CREATE INDEX "AiAgent_tenantId_idx" ON "AiAgent"("tenantId");

ALTER TABLE "AiAgent" ADD CONSTRAINT "AiAgent_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AiAgent" ADD CONSTRAINT "AiAgent_extensionId_fkey" FOREIGN KEY ("extensionId") REFERENCES "Extension"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- AiProviderCredential ----------------------------------------------------
CREATE TABLE "AiProviderCredential" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "apiKeyCipher" TEXT NOT NULL,
    "region" TEXT,
    "baseUrl" TEXT,
    "cachedModels" JSONB,
    "fetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiProviderCredential_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiProviderCredential_tenantId_provider_label_key" ON "AiProviderCredential"("tenantId", "provider", "label");
CREATE INDEX "AiProviderCredential_tenantId_idx" ON "AiProviderCredential"("tenantId");

ALTER TABLE "AiProviderCredential" ADD CONSTRAINT "AiProviderCredential_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- --- AiCallSession -----------------------------------------------------------
CREATE TABLE "AiCallSession" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "aiAgentId" TEXT NOT NULL,
    "cdrUniqueId" TEXT NOT NULL,
    "transcript" JSONB,
    "summary" TEXT,
    "latencyMsP50" INTEGER,
    "latencyMsP95" INTEGER,
    "costTokensInput" INTEGER,
    "costTokensOutput" INTEGER,
    "outcome" TEXT,
    "handoffExtensionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiCallSession_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AiCallSession_tenantId_idx" ON "AiCallSession"("tenantId");
CREATE INDEX "AiCallSession_cdrUniqueId_idx" ON "AiCallSession"("cdrUniqueId");
CREATE INDEX "AiCallSession_aiAgentId_idx" ON "AiCallSession"("aiAgentId");

ALTER TABLE "AiCallSession" ADD CONSTRAINT "AiCallSession_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AiCallSession" ADD CONSTRAINT "AiCallSession_aiAgentId_fkey" FOREIGN KEY ("aiAgentId") REFERENCES "AiAgent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
