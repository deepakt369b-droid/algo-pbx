-- Multi-tenant SaaS foundation — WAVE 2a "belt and braces" row-level
-- security (2026-09-04). Adds Postgres RLS to the four highest-value
-- tables named in the plan (§2): CallDetailRecord, Recording, Contact,
-- ChatMessage. This is a SECOND, independent layer of tenant isolation on
-- top of the Prisma `$extends` scoping in `src/lib/db-tenant.ts` — it
-- exists specifically to catch the paths the Prisma extension cannot see:
-- a bug in the extension itself, a stray `$queryRaw`/`$executeRaw`, or (in
-- a later wave) the Asterisk dialplan's direct ODBC reads.
--
-- THIS MIGRATION IS INERT UNTIL ALL THREE OF THE FOLLOWING ARE TRUE. Any
-- one of them being false means these policies are either silently
-- bypassed or actively unsafe. Verify all three at deploy time — none of
-- them can be checked or enforced from this file:
--
-- 1. THE GUC MUST BE SET WITH `SET LOCAL`, NEVER A PLAIN `SET`, AND ONLY
--    FROM INSIDE THE SAME TRANSACTION AS THE QUERY IT PROTECTS.
--    `src/lib/db-tenant.ts` already does this correctly (every query it
--    issues runs inside `unsafeGlobalDb.$transaction(...)`, and the very
--    first statement in that transaction is
--    `SELECT set_config('app.tenant_id', $1, true)` — the `true` third
--    argument is exactly what makes it transaction-local). A plain `SET`
--    persists on the physical connection: under connection pooling
--    (PgBouncer transaction mode, or Prisma's own internal pool) a
--    recycled connection would leak tenant A's GUC value into tenant B's
--    next transaction — silently returning the WRONG tenant's rows rather
--    than none, which is a worse failure than having no RLS at all,
--    because it looks like it is working. If this file is ever adapted
--    for a query path that does NOT go through db-tenant.ts, that path
--    must reproduce the same `SET LOCAL`-inside-the-transaction discipline
--    or these policies give it no protection.
--
-- 2. THE APPLICATION'S POSTGRES ROLE MUST BE NON-SUPERUSER AND MUST NOT
--    HAVE THE `BYPASSRLS` ATTRIBUTE. Postgres silently no-ops every RLS
--    policy for a superuser or a BYPASSRLS role — `ENABLE ROW LEVEL
--    SECURITY` succeeds, the policies below get created, and none of it
--    does anything; there is no error, no warning, nothing in the logs.
--    This CANNOT be verified from this migration file or from this
--    (no-live-DB) development environment. Before relying on this
--    migration in production, run, connected as the app's actual role:
--        SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user;
--    Both columns MUST read `false`. If the app currently connects as a
--    superuser (common for a single-tenant deployment that never needed
--    to care), this migration buys nothing until that is fixed — do not
--    treat "the migration applied cleanly" as evidence RLS is enforcing
--    anything.
--
-- 3. PGBOUNCER / CONNECTION-POOLING MODE. `SET LOCAL` requires the
--    statement and the query it protects to run on the SAME physical
--    connection within the SAME transaction. This is compatible with
--    PgBouncer in "transaction" pooling mode (a connection is only handed
--    back to the pool between transactions, never mid-transaction) and
--    with no pooler at all. It is NOT compatible with PgBouncer's
--    "statement" pooling mode, and "session" mode makes the earlier
--    plain-`SET`-leak risk irrelevant only because a session-mode
--    connection isn't shared anyway (defeating the purpose of pooling).
--    Confirm the deployed pooling mode before enabling — if it is
--    anything other than "transaction" mode or no pooling, these policies
--    can silently misbehave in ways this migration cannot detect.
--
-- Design decision — RLS scope vs. SupportGrant (plan §2/§3): these
-- policies enforce ONLY "does this row's tenantId match the session GUC".
-- They deliberately do NOT know anything about SupportGrant or the
-- PLATFORM_SUPPORT role. Reasoning:
--   - Keeping the SQL-level policy simple (one equality check) keeps it
--     auditable at a glance — the property "no row leaks across tenants"
--     should not depend on correctly re-implementing grant-expiry logic
--     in a SQL policy predicate.
--   - Platform support access is inherently a "read AS a specific tenant,
--     temporarily, with a reason" operation, not a "read across all
--     tenants at once" operation (plan §3: a grant is scoped to ONE
--     tenant, is time-boxed, and produces a dual audit-log write). That
--     maps naturally onto the SAME mechanism tenant requests use: when a
--     platform-support session acts on tenant X under a live grant, the
--     application layer resolves `tenantDb(tenantX.id)` exactly as it
--     would for a normal session, and the `SET LOCAL app.tenant_id`
--     transaction wrapper sets the SAME GUC these policies check. No
--     policy-level SupportGrant awareness is needed for that path to work.
--   - What DOES need to live at the application layer (future wave, not
--     this migration): verifying a SupportGrant is live (not expired, not
--     revoked) BEFORE ever calling `tenantDb()` on a platform-support
--     user's behalf, and writing the dual audit-log entries. RLS is not
--     the right layer to check "is there a non-expired row in
--     SupportGrant" — that is exactly the kind of business-logic
--     condition that belongs in `src/lib/platform-guard.ts` (a later
--     wave), not in a row-security predicate that runs on every single
--     row of every query.
--
-- Rollback: `ALTER TABLE "<table>" DISABLE ROW LEVEL SECURITY;` per table,
-- or `DROP POLICY` the four policies below — either is non-destructive
-- (no data is touched) and safe to run at any time.

ALTER TABLE "CallDetailRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Recording" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Contact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ChatMessage" ENABLE ROW LEVEL SECURITY;

-- FORCE ROW LEVEL SECURITY so the policy also applies to the table owner
-- (the app's migration/DDL role may well be the table owner even when the
-- runtime app role is a different, more restricted one) — without FORCE,
-- Postgres exempts the owning role from RLS by default the same way it
-- exempts superusers, which would quietly punch the same hole precondition
-- #2 above warns about if the app ever connects as the owning role.
ALTER TABLE "CallDetailRecord" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Recording" FORCE ROW LEVEL SECURITY;
ALTER TABLE "Contact" FORCE ROW LEVEL SECURITY;
ALTER TABLE "ChatMessage" FORCE ROW LEVEL SECURITY;

-- Each policy: a row is visible/writable only when its "tenantId" matches
-- the session GUC. `current_setting('app.tenant_id', true)` — the `true`
-- second argument means "return NULL instead of raising if unset" rather
-- than erroring out a connection that (by mistake, or via unsafeGlobalDb's
-- own maintenance/migration use) never set the GUC at all; NULL never
-- equals any "tenantId" value, so an unset GUC denies every row rather
-- than granting all of them — fails closed, not open.
--
-- USING governs SELECT/UPDATE/DELETE visibility; WITH CHECK additionally
-- governs INSERT/UPDATE so a session can't write a row it could not
-- itself later read back (i.e. can't plant a row under a different
-- tenantId than its own session GUC).

CREATE POLICY tenant_isolation ON "CallDetailRecord"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation ON "Recording"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation ON "Contact"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

CREATE POLICY tenant_isolation ON "ChatMessage"
  USING ("tenantId" = current_setting('app.tenant_id', true))
  WITH CHECK ("tenantId" = current_setting('app.tenant_id', true));

-- NOTE ON SEQUENCING: this migration references "tenantId" columns that,
-- as of prisma/migrations/20260904100000_add_tenancy (step 1), exist but
-- are still NULLABLE with no NOT NULL constraint yet — step 3 (not yet a
-- real migration folder; see that migration's header) is what makes them
-- required. RLS still functions correctly against a nullable column: a
-- row with "tenantId" IS NULL simply matches no session GUC value (NULL
-- never equals anything, including via current_setting's NULL-on-unset
-- return), so such a row is invisible under every tenant's session until
-- step 2's backfill gives it a real tenantId. No orphaned row becomes
-- visible to the wrong tenant as an accidental side effect of this
-- migration running before step 3.
