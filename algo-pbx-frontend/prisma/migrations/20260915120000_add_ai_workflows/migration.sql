-- Conversation-workflow builder + real model configuration (2026-09-15,
-- follow-up to §34/§35 — see ~/.claude/plans/currently-we-have-forked-
-- mutable-giraffe.md for the full design). STRICTLY ADDITIVE throughout:
-- every new AiAgent column is nullable or defaulted, so every existing row
-- (including the live production tenant) is untouched and behaves exactly
-- as before this migration. AiWorkflow/AiWorkflowVersion/AiWorkflowSecret
-- are three new tables with no data to backfill.

-- --- AiAgent: workflow mode + model-configuration columns -------------------
ALTER TABLE "AiAgent" ADD COLUMN "promptMode" TEXT NOT NULL DEFAULT 'SIMPLE';
ALTER TABLE "AiAgent" ADD COLUMN "llmTemperature" DOUBLE PRECISION;
ALTER TABLE "AiAgent" ADD COLUMN "llmMaxTokens" INTEGER;
ALTER TABLE "AiAgent" ADD COLUMN "ttsSpeed" DOUBLE PRECISION;
ALTER TABLE "AiAgent" ADD COLUMN "sttLanguage" TEXT;
ALTER TABLE "AiAgent" ADD COLUMN "allowInterruption" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "AiAgent" ADD COLUMN "vadEnergyThreshold" DOUBLE PRECISION;
ALTER TABLE "AiAgent" ADD COLUMN "vadSilenceFrames" INTEGER;
ALTER TABLE "AiAgent" ADD COLUMN "bargeInThreshold" DOUBLE PRECISION;
ALTER TABLE "AiAgent" ADD COLUMN "bargeInConsecutiveFrames" INTEGER;

-- --- AiCallSession: workflow debuggability ----------------------------------
ALTER TABLE "AiCallSession" ADD COLUMN "gatheredContext" JSONB;
ALTER TABLE "AiCallSession" ADD COLUMN "nodePath" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- --- AiWorkflow --------------------------------------------------------------
CREATE TABLE "AiWorkflow" (
    "id"                 TEXT NOT NULL,
    "tenantId"           TEXT NOT NULL,
    "agentId"            TEXT NOT NULL,
    "draftGraph"         JSONB NOT NULL,
    "publishedVersionId" TEXT,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiWorkflow_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiWorkflow_agentId_key" ON "AiWorkflow"("agentId");
CREATE UNIQUE INDEX "AiWorkflow_publishedVersionId_key" ON "AiWorkflow"("publishedVersionId");
CREATE INDEX "AiWorkflow_tenantId_idx" ON "AiWorkflow"("tenantId");

ALTER TABLE "AiWorkflow" ADD CONSTRAINT "AiWorkflow_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AiWorkflow" ADD CONSTRAINT "AiWorkflow_agentId_fkey" FOREIGN KEY ("agentId") REFERENCES "AiAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- --- AiWorkflowVersion -------------------------------------------------------
CREATE TABLE "AiWorkflowVersion" (
    "id"                TEXT NOT NULL,
    "tenantId"          TEXT NOT NULL,
    "workflowId"        TEXT NOT NULL,
    "version"           INTEGER NOT NULL,
    "graph"             JSONB NOT NULL,
    "publishedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedByUserId" TEXT,

    CONSTRAINT "AiWorkflowVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiWorkflowVersion_workflowId_version_key" ON "AiWorkflowVersion"("workflowId", "version");
CREATE INDEX "AiWorkflowVersion_tenantId_idx" ON "AiWorkflowVersion"("tenantId");

ALTER TABLE "AiWorkflowVersion" ADD CONSTRAINT "AiWorkflowVersion_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AiWorkflowVersion" ADD CONSTRAINT "AiWorkflowVersion_workflowId_fkey" FOREIGN KEY ("workflowId") REFERENCES "AiWorkflow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AiWorkflow.publishedVersionId -> AiWorkflowVersion.id. Added after both
-- tables exist (the two FKs are mutually circular by design - a workflow
-- points at its published version, a version points back at its owning
-- workflow - which Postgres allows without any deferred-constraint
-- machinery since publishedVersionId is nullable: a workflow row is always
-- inserted with publishedVersionId NULL first, then updated once a version
-- exists to point at).
ALTER TABLE "AiWorkflow" ADD CONSTRAINT "AiWorkflow_publishedVersionId_fkey" FOREIGN KEY ("publishedVersionId") REFERENCES "AiWorkflowVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- --- AiWorkflowSecret ---------------------------------------------------------
CREATE TABLE "AiWorkflowSecret" (
    "id"          TEXT NOT NULL,
    "tenantId"    TEXT NOT NULL,
    "key"         TEXT NOT NULL,
    "valueCipher" TEXT NOT NULL,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiWorkflowSecret_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiWorkflowSecret_tenantId_key_key" ON "AiWorkflowSecret"("tenantId", "key");
CREATE INDEX "AiWorkflowSecret_tenantId_idx" ON "AiWorkflowSecret"("tenantId");

ALTER TABLE "AiWorkflowSecret" ADD CONSTRAINT "AiWorkflowSecret_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
