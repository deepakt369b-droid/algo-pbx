-- Platform owner console, migration A (waves 4-7 foundations, 2026-09-06).
--
-- STRICTLY ADDITIVE. Every column is nullable with no default and no
-- backfill, so:
--   * existing rows are untouched and remain valid,
--   * no table is rewritten (Postgres adds a nullable column as a catalog-only
--     change), so this is fast even on the production Tenant table,
--   * the migration is trivially reversible by dropping the columns.
--
-- Nothing here is tenant-scoped data, so no RLS policy changes are needed:
-- Tenant and PlatformUser are both platform-plane tables that the
-- 20260904120000_add_rls migration deliberately left alone.

-- --- Tenant: provisioning pipeline state -----------------------------------
-- Shaped by src/lib/platform/provisioning-machine.ts's ProvisioningState.
-- Resumable working state only; the authoritative "who did what when" record
-- is PlatformAuditLog's provisioning.step rows.
ALTER TABLE "Tenant" ADD COLUMN "provisioningState" JSONB;

-- --- Tenant: lifecycle timestamps -----------------------------------------
-- Each written by its own explicit, reasoned, audited owner action.
-- "dialplanCutAt" is the ONLY telephony-affecting column on this table and is
-- deliberately separate from the billing fields: per the approved plan, the
-- enforcement ladder governs UI login and nothing else, and no automatic path
-- (cron, paidUntil lapse, billingStatus transition) may ever set this.
ALTER TABLE "Tenant" ADD COLUMN "suspendedAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "offboardedAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "dialplanCutAt" TIMESTAMP(3);

-- --- Tenant: per-tenant onboarding compliance checklist --------------------
-- Timestamps rather than booleans: an auditor asks "when was this filed".
-- An incomplete checklist does not block tenant creation; it raises a
-- persistent warning (src/lib/platform/compliance.ts).
ALTER TABLE "Tenant" ADD COLUMN "complianceTypeApprovalFiledAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "complianceEtisalatLetterAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "complianceAupSignedAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "compliancePdplTermsSignedAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "complianceRecordingDisclosureAt" TIMESTAMP(3);
ALTER TABLE "Tenant" ADD COLUMN "complianceNotes" TEXT;

-- --- PlatformUser: owner console management fields -------------------------
-- "createdById" is intentionally a plain TEXT column, not a self-referencing
-- FK: the bootstrap owner is created by scripts/create-platform-user.mjs with
-- no creator, and a self-relation would add a cycle for a field that exists
-- only for audit legibility. PlatformAuditLog holds the authoritative record.
ALTER TABLE "PlatformUser" ADD COLUMN "lastLoginAt" TIMESTAMP(3);
ALTER TABLE "PlatformUser" ADD COLUMN "createdById" TEXT;
ALTER TABLE "PlatformUser" ADD COLUMN "disabledAt" TIMESTAMP(3);
ALTER TABLE "PlatformUser" ADD COLUMN "totpResetAt" TIMESTAMP(3);

-- Backfill "disabledAt" for any already-disabled account so the users list
-- does not show "disabled, date unknown". epoch-safe: uses the row's own
-- creation time as the only defensible lower bound we actually have, rather
-- than now() (which would falsely claim the account was disabled today).
UPDATE "PlatformUser" SET "disabledAt" = "createdAt" WHERE "disabled" = true AND "disabledAt" IS NULL;

-- --- Indexes ---------------------------------------------------------------
-- The overview's attention queue scans for tenants mid-provisioning and for
-- lifecycle state; both are small tables today, but these keep the dashboard
-- queries index-backed as tenant count grows.
CREATE INDEX "Tenant_dialplanCutAt_idx" ON "Tenant"("dialplanCutAt");
CREATE INDEX "PlatformUser_disabled_idx" ON "PlatformUser"("disabled");
