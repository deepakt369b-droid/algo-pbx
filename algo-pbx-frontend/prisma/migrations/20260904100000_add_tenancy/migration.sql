-- Multi-tenant SaaS foundation — WAVE 1, STEP 1 of 3 (2026-09-04).
-- Hand-authored, mirrors Prisma's generated shape for the new platform-plane
-- tables and the tenantId column added to every customer-owned model; not
-- run against a live shadow DB from this environment (Postgres is VPS-only,
-- loopback-bound, per this repo's existing convention — see LLM.md's P2
-- section). MUST be verified with `prisma migrate deploy` against the real
-- container, and the deploy output MUST name this migration explicitly.
--
-- THIS IS DELIBERATELY ONLY STEP 1 OF 3 (plan §1 "The migration", amended).
-- The three-step design exists so no window ever has the app seeing a
-- column it cannot satisfy, and so the destructive/constraining half never
-- runs before every row has a tenantId:
--
--   STEP 1 (this file) — ADDITIVE ONLY.
--     - Create Tenant, PlatformUser, SupportGrant, PlatformAuditLog.
--     - Insert tenant #1 (slug "sahara") — our current single deployment.
--     - Add "tenantId" to every customer-owned table as NULLABLE, NO FK.
--     Old application code is completely unaffected: the column exists but
--     nothing reads or requires it yet. Safe to deploy standalone.
--
--   STEP 2 — BATCHED BACKFILL, NOT SQL IN THIS FILE.
--     Run `algo-pbx-frontend/scripts/migrate-backfill-tenancy.ts` (tsx) —
--     per-table, batched (default 5000 rows/batch), idempotent
--     (`WHERE "tenantId" IS NULL`), safely re-runnable if interrupted, with
--     progress logging. Deliberately NOT run inside this migration: a
--     single 30-table transaction would hold locks for the entire backfill
--     duration on a live DB.
--
--   STEP 3 — SEPARATE FOLLOW-UP MIGRATION, NOT YET IN prisma/migrations/.
--     The finished SQL for step 3 (assert zero orphans, then SET NOT NULL +
--     add FKs + drop old single-column uniques + create composite uniques +
--     create tenantId indexes) is written and ready at
--     "step3_constrain.sql.template" in this same migration folder — but it
--     is deliberately NOT named "migration.sql" and deliberately NOT its own
--     migrations/<timestamp>_.../ folder yet, so `prisma migrate deploy`
--     cannot accidentally run it back-to-back with step 1 before the
--     backfill has happened (Prisma applies every pending migration folder
--     in one `migrate deploy` invocation with no pause in between — there is
--     no built-in place to run an external script mid-deploy). Promote it to
--     a real migration once rehearse-tenancy-migration.ts reports zero
--     orphans and a human has signed off — see that file's header and this
--     folder's step3_constrain.sql.template header for the exact promotion
--     steps.
--
-- Rollback (if step 1 alone fails or needs undoing before step 2/3 run):
-- restore from the pre-migration snapshot (plan D3). Because this step is
-- purely additive, a failure DURING step 1 needs no restore at all — just
-- re-run `prisma migrate deploy`.

-- CreateEnum
CREATE TYPE "TenantStatus" AS ENUM ('TRIAL', 'ACTIVE', 'SUSPENDED', 'OFFBOARDED');

-- CreateEnum
CREATE TYPE "BillingStatus" AS ENUM ('TRIAL', 'ACTIVE', 'PAST_DUE', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "PlatformRole" AS ENUM ('PLATFORM_OWNER', 'PLATFORM_SUPPORT');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "TenantStatus" NOT NULL DEFAULT 'TRIAL',
    "plan" TEXT NOT NULL DEFAULT 'standard',
    "seats" INTEGER NOT NULL DEFAULT 5,
    "billingStatus" "BillingStatus" NOT NULL DEFAULT 'TRIAL',
    "paidUntil" TIMESTAMP(3),
    "billingRef" TEXT,
    "billingProvider" TEXT,
    "tunnelSubnetIndex" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformUser" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "PlatformRole" NOT NULL DEFAULT 'PLATFORM_SUPPORT',
    "totpSecret" TEXT,
    "totpConfirmedAt" TIMESTAMP(3),
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportGrant" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "platformUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "SupportGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformAuditLog" (
    "id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "platformUserId" TEXT,
    "tenantId" TEXT,
    "reason" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlatformAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_tunnelSubnetIndex_key" ON "Tenant"("tunnelSubnetIndex");

-- CreateIndex
CREATE INDEX "Tenant_status_idx" ON "Tenant"("status");

-- CreateIndex
CREATE INDEX "Tenant_billingStatus_paidUntil_idx" ON "Tenant"("billingStatus", "paidUntil");

-- CreateIndex
CREATE UNIQUE INDEX "PlatformUser_email_key" ON "PlatformUser"("email");

-- CreateIndex
CREATE INDEX "SupportGrant_tenantId_expiresAt_idx" ON "SupportGrant"("tenantId", "expiresAt");

-- CreateIndex
CREATE INDEX "SupportGrant_platformUserId_idx" ON "SupportGrant"("platformUserId");

-- CreateIndex
CREATE INDEX "PlatformAuditLog_tenantId_createdAt_idx" ON "PlatformAuditLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "PlatformAuditLog_action_idx" ON "PlatformAuditLog"("action");

-- AddForeignKey
ALTER TABLE "SupportGrant" ADD CONSTRAINT "SupportGrant_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportGrant" ADD CONSTRAINT "SupportGrant_platformUserId_fkey" FOREIGN KEY ("platformUserId") REFERENCES "PlatformUser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Seed tenant #1: our current single deployment. slug "sahara" per plan §1.
-- billingStatus/status ACTIVE, paidUntil far in the future (this tenant is
-- never subject to the billing enforcement ladder introduced in a later
-- wave), tunnelSubnetIndex 0 (10.8.0.0/24 — the /24 already in live use,
-- see LLM.md's OpenVPN section; matches plan §4's "tenant n owns 10.8.n.0/24"
-- with tenant #1 keeping the block already deployed).
--
-- updatedAt has no DB-side default (Prisma's @updatedAt is client-managed),
-- so it is set explicitly here to now() for this one hand-authored insert.
INSERT INTO "Tenant" ("id", "slug", "name", "status", "plan", "seats", "billingStatus", "paidUntil", "tunnelSubnetIndex", "createdAt", "updatedAt")
VALUES ('tenant_sahara_001', 'sahara', 'Sahara (tenant #1)', 'ACTIVE', 'standard', 999, 'ACTIVE', '2099-01-01 00:00:00+00', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

-- Add "tenantId" as NULLABLE, NO FK, to every customer-owned table (plan §1
-- table + exploration findings, ~34 models). Backfilled by
-- scripts/migrate-backfill-tenancy.ts (step 2), then constrained by step 3
-- (SET NOT NULL + FK + composite uniques + indexes) once every row has one.

-- AlterTable
ALTER TABLE "User" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "OtpChallenge" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "TrustedDevice" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "LoginAttempt" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "Invite" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "Extension" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "Queue" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "QueueMember" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "CallDetailRecord" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "DoNotCallEntry" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "Recording" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "AuditLog" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "CallQualitySample" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "EscalationTarget" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "EscalationAttempt" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "WaInstance" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "Contact" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "ContactTransferRequest" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "ContactNote" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "ContactTask" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "CallDisposition" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "Company" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "PipelineStage" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "Deal" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "DealNote" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "Activity" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "Room" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "SmsAccessRequest" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "WebhookSubscription" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "ApiKey" ADD COLUMN "tenantId" TEXT;
-- AlterTable — AppSetting's tenantId STAYS nullable even after step 3
-- (null = platform default, a row = tenant override; plan §1/§7).
ALTER TABLE "AppSetting" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "GatewayEvent" ADD COLUMN "tenantId" TEXT;
-- AlterTable
ALTER TABLE "GatewaySite" ADD COLUMN "tenantId" TEXT;

-- NOT touched, deliberately (plan §1/§7 classification — platform-global,
-- no tenantId at all): "PbxRuntimeFlag", "McpApproval",
-- "InboundWebhookDelivery".
