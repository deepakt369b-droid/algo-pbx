import { unsafeGlobalDb } from "@/lib/db";
import { computeScopedArgs, type ScopedArgs } from "@/lib/tenancy/scope-rules";

// Multi-tenant SaaS foundation, wave 2a (plan §2 "Mechanically enforced
// tenant scoping"). This is the enforcement MECHANISM: a Prisma `$extends`
// client, scoped to exactly one tenant, handed out by the auth guards in
// `src/lib/auth-guard.ts` and used in place of the raw `unsafeGlobalDb`
// everywhere a request has a known tenant.
//
// What it does, per query:
//   1. Look up the model's tenancy rule (`computeScopedArgs`, pure, unit
//      tested in isolation — see `src/lib/tenancy/scope-rules.ts` and its
//      test file). Throws for any model not on the known tenant-scoped
//      list, so a newly added model with no tenancy story fails the build
//      loudly instead of leaking data silently.
//   2. Run the (now tenant-filtered) query inside its own short
//      transaction that first sets the `app.tenant_id` Postgres session
//      GUC via `SET LOCAL` — see the "why SET LOCAL, why set_config()"
//      block below. This is the "belt and braces" half: it makes the
//      row-level security policies added in
//      `prisma/migrations/<ts>_add_rls/migration.sql` actually apply to
//      this connection for this query, defending against the paths the
//      Prisma extension itself cannot see (raw SQL, the dialplan's direct
//      ODBC reads, a future bug in this file). See that migration's
//      header comment for the RLS design and its deployment
//      preconditions (non-superuser DB role, PgBouncer transaction-pooling
//      compatibility) — none of which this file can verify from here.
//
// Known bypasses NOT handled by this file (plan §2's "known bypasses"
// list) — each is either out of scope for wave 2a or handled elsewhere:
//   - Asterisk's direct ODBC reads (func_odbc.conf) — wave 6.
//   - `ApiKey` bearer routes (`src/lib/api-key-auth.ts`) — a later wave's
//     job to return a scoped client from `requireApiKey()` the same way.
//   - `scripts/create-admin-user.mjs`'s own `new PrismaClient()` — a
//     separate, explicitly-out-of-scope fix per this wave's task brief.
//   - Any `$queryRaw`/`$executeRaw` call site outside this file — the
//     Prisma extension's `query` hook does not intercept raw queries at
//     all; those call sites must be audited and scoped by hand.

export type TenantClient = ReturnType<typeof tenantDb>;

/**
 * Returns a Prisma client scoped to exactly one tenant. Every `find*`,
 * `update*`, `delete*`, `count`, `aggregate`, `groupBy`, `create*` and
 * `upsert` call issued through it is automatically filtered/tagged with
 * `tenantId`, and additionally runs inside a transaction that sets the
 * `app.tenant_id` session GUC for the RLS policies to see. Throws
 * synchronously (at call time, not lazily) if `tenantId` is empty, and
 * throws per-query for any model `computeScopedArgs` rejects.
 */
export function tenantDb(tenantId: string) {
  if (!tenantId) {
    throw new Error("tenantDb(): tenantId is required and must be non-empty");
  }

  return unsafeGlobalDb.$extends({
    name: `tenant-scope:${tenantId}`,
    query: {
      $allModels: {
        async $allOperations({ model, operation, args }) {
          const scopedArgs = computeScopedArgs(model, operation, args as ScopedArgs, tenantId);

          // Delegate property names on the Prisma client are always the
          // model name with its first letter lowercased (e.g.
          // "CallDetailRecord" -> "callDetailRecord") — this is a stable
          // property of Prisma's code generator, not a guess, and holds
          // for every model this extension is allowed to reach (all of
          // them passed through computeScopedArgs without throwing).
          const delegateName = model.charAt(0).toLowerCase() + model.slice(1);

          return unsafeGlobalDb.$transaction(async (tx) => {
            // Why SET LOCAL via set_config(), not a plain SET, and not
            // string-interpolated SQL:
            //   - `SET LOCAL` (the third argument to set_config, `true`,
            //     means "local to the transaction") resets automatically
            //     when this transaction ends. A plain `SET` persists on
            //     the physical connection — under connection pooling
            //     (PgBouncer transaction mode, or Prisma's own pool) a
            //     later request could reuse that same connection and
            //     silently inherit the PREVIOUS tenant's GUC, which is a
            //     worse failure than having no RLS at all: it would look
            //     like isolation is working. This is why every query gets
            //     its own transaction here rather than trying to share
            //     one across a request.
            //   - `set_config('app.tenant_id', $1, true)` is a normal SQL
            //     function call, so `tenantId` is passed as a bound
            //     parameter via Prisma's tagged-template `$executeRaw`
            //     (parameterized, not string-interpolated) — never
            //     `$executeRawUnsafe` with the value spliced into the SQL
            //     text. `SET LOCAL app.tenant_id = '<value>'` cannot
            //     itself take a bound parameter (SET does not accept
            //     query parameters in Postgres's wire protocol), which is
            //     exactly why set_config() — a real function call — is
            //     the standard way to set a GUC from user input safely.
            await tx.$executeRaw`SELECT set_config('app.tenant_id', ${tenantId}, true)`;

            // Prisma's transaction client type doesn't expose delegates by
            // dynamic string key; this repo's eslint config (next/core-web-
            // vitals only) doesn't register @typescript-eslint rules, so no
            // disable directive is needed here — `any` alone is fine.
            const delegate = (tx as any)[delegateName];
            if (!delegate || typeof delegate[operation] !== "function") {
              throw new Error(`tenantDb(): no delegate/operation for ${model}.${operation}`);
            }
            return delegate[operation](scopedArgs);
          });
        },
      },
    },
  });
}
