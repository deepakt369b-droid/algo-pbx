-- Multi-transport connectivity + automatic failover (plan §3.2, 2026-09-08).
--
-- STRICTLY ADDITIVE. Every new column is either nullable with no default or
-- has a default that preserves today's behavior exactly, so:
--   * existing GatewaySite/Tenant rows are untouched and remain valid,
--   * no table is rewritten (adding a column with a constant default or
--     NULL is a catalog-only change on Postgres 11+), so this is fast even
--     on the live GatewaySite/Tenant tables,
--   * the migration is trivially reversible by dropping the added enum
--     value's usages (none exist yet) and the added columns.
--
-- Behavior is unchanged until an operator explicitly acts:
--   * "priority" defaults to 100 for every existing site, so a tenant with
--     one site today keeps exactly one candidate primary.
--   * "enabled" defaults to true, so no existing site is silently excluded
--     from selection.
--   * "failoverEnabled" defaults to FALSE on every tenant (plan §3.2 / H2)
--     — the automatic-cutover supervisor (W3) is a no-op for every tenant
--     until an operator turns it on, after its probes have agreed with
--     reality for a few days.
--   * "activeGatewaySiteId" starts NULL for every tenant; it is only ever
--     written by the existing, already AMI-read-back-verified
--     cutoverToSite() path (manual "Cut over now" or the future automatic
--     supervisor), never by this migration.

-- --- SiteTransport: add WireGuard as a fourth transport kind ---------------
-- Postgres requires ADD VALUE to run before it is referenced; no existing
-- row uses it, so nothing downstream changes until a site is explicitly
-- switched to it via the transports UI (W2).
ALTER TYPE "SiteTransport" ADD VALUE 'WIREGUARD';

-- --- GatewaySite: priority, enable switch, encrypted config, cutover clock -
ALTER TABLE "GatewaySite" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 100;
ALTER TABLE "GatewaySite" ADD COLUMN "enabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "GatewaySite" ADD COLUMN "configEncrypted" TEXT;
ALTER TABLE "GatewaySite" ADD COLUMN "lastFailoverAt" TIMESTAMP(3);

-- --- Tenant: which site is active, and whether failover may move it -------
ALTER TABLE "Tenant" ADD COLUMN "activeGatewaySiteId" TEXT;
ALTER TABLE "Tenant" ADD COLUMN "failoverEnabled" BOOLEAN NOT NULL DEFAULT false;
