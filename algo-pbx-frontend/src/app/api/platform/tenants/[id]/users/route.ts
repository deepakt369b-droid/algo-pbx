import { NextRequest, NextResponse } from "next/server";
import { unsafeGlobalDb as db } from "@/lib/db";
import { tenantDb } from "@/lib/db-tenant";
import { requirePlatformSession } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

// GET /api/platform/tenants/[id]/users — the tenant's own User directory, for
// the owner console's Users tab (plan §1: "No tenant-user management — the
// owner cannot see or act on users INSIDE a tenant").
//
// Any platform session may read this list (owner or support) — listing is
// not itself a change, and the Users tab's mutating actions are gated
// owner-only separately, at PATCH .../users/[userId].
//
// Reads go through `tenantDb(tenantId)` (src/lib/db-tenant.ts), NOT
// `unsafeGlobalDb` — the same tenant-scoping/RLS mechanism every tenant-plane
// route already uses, per plan §1's explicit instruction. This route does
// not go through src/lib/support-grant.ts's time-boxed grant mechanism:
// that module governs read access to a tenant's CALL content (recordings,
// conversations, CDRs) for a PLATFORM_SUPPORT operator, per its own header
// comment ("the ONLY thing that lets ... actually see a tenant's data",
// referring to that content). The owner console's tenant list/detail pages
// already read a tenant's User/Extension counts and identities unconditionally
// (see loadTenantDetail()) as basic account administration, not customer
// content — this route is the same category of read, just itemised instead
// of counted.
export const GET = withApiErrorHandler(async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const guard = await requirePlatformSession();
  if ("response" in guard) return guard.response;

  const tenant = await db.tenant.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  const scoped = tenantDb(tenant.id);
  const users = await scoped.user.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      disabled: true,
      disabledAt: true,
      createdAt: true,
      extension: { select: { number: true } },
      // User has no lastLoginAt column (only PlatformUser does — see
      // prisma/schema.prisma) — there is nothing to surface here today.
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({
    users: users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      role: u.role,
      disabled: u.disabled,
      disabledAt: u.disabledAt,
      createdAt: u.createdAt,
      extensionNumber: u.extension?.number ?? null,
      lastLoginAt: null,
    })),
  });
});
