import { NextRequest, NextResponse } from "next/server";
import { unsafeGlobalDb as db } from "@/lib/db";
import { requirePlatformSession } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

// GET /api/platform/tenants/[id]/extensions — the tenant's extension roster
// for the owner console's tenant-management modal (W1, extensions panel).
//
// Read-only for any platform session (owner or support), same reasoning as
// GET .../users: listing is not itself a change. Assignment/dial-permission
// writes are owner-only, at PATCH .../extensions/[extensionId].
export const GET = withApiErrorHandler(async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const guard = await requirePlatformSession();
  if ("response" in guard) return guard.response;

  const tenant = await db.tenant.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  const extensions = await db.extension.findMany({
    where: { tenantId: tenant.id },
    select: {
      id: true,
      number: true,
      kind: true,
      dialPermission: true,
      geoAllowedCountries: true,
      geoLockedAt: true,
      user: { select: { id: true, email: true, name: true } },
    },
    orderBy: { number: "asc" },
  });

  return NextResponse.json({
    extensions: extensions.map((e) => ({
      id: e.id,
      number: e.number,
      kind: e.kind,
      dialPermission: e.dialPermission,
      geoAllowedCountries: e.geoAllowedCountries,
      geoLockedAt: e.geoLockedAt,
      user: e.user,
    })),
  });
});
