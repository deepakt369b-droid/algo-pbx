import { PrismaClient } from "@prisma/client";

// Standard Next.js dev-mode singleton so hot-reload doesn't exhaust Postgres
// connections by re-instantiating PrismaClient on every module reload.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

// Multi-tenant SaaS foundation, wave 2a (plan §2): this is the RAW,
// UNSCOPED Prisma client — every query issued through it can read or write
// every tenant's rows with no filter at all. It was named `db` and imported
// by ~135 route files until this rename. The name is now loud on purpose:
// `tenantDb(tenantId)` in `src/lib/db-tenant.ts` is what almost everything
// should use instead (handed out by the `requireSession`/`requireStaffSession`
// /`requireAdminSession` guards in `src/lib/auth-guard.ts`), and renaming
// this export turns `tsc` into the enforcement mechanism: any route that
// still imports `db` by its old name now fails to compile rather than
// silently keeping unscoped access. See LLM.md's wave-2 Build Log entry —
// waves 2b-2e are the (separate, in-flight) sweep that fixes those routes.
//
// Legitimate direct uses of this export are narrow and should stay narrow:
// platform-global models that a tenant scope must never touch
// (`PbxRuntimeFlag`, `McpApproval`, `InboundWebhookDelivery`), the
// tenant-resolution lookup itself (you need an unscoped read of `Tenant` to
// find a tenantId before you can build a scoped client), and one-off admin
// scripts like `scripts/create-admin-user.mjs` that operate before any
// session/tenant context exists.
export const unsafeGlobalDb = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = unsafeGlobalDb;
}
