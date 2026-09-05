import { NextRequest, NextResponse } from "next/server";
import { requirePlatformSession } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { queryAuditPage } from "@/lib/platform/audit-query";

export const dynamic = "force-dynamic";

// GET /api/platform/audit — paginated, filtered audit rows.
//
// Readable by any platform session. The audit log is a mutual accountability
// record, not owner-private: a support operator being able to see what was
// done to a tenant they are helping is the point, and restricting the record
// to the people most able to act unobserved would be exactly backwards.
export const GET = withApiErrorHandler(async function GET(req: NextRequest) {
  const guard = await requirePlatformSession();
  if ("response" in guard) return guard.response;

  const sp = req.nextUrl.searchParams;
  const result = await queryAuditPage({
    action: sp.get("action") ?? undefined,
    actorId: sp.get("actorId") ?? undefined,
    tenantId: sp.get("tenantId") ?? undefined,
    from: sp.get("from") ?? undefined,
    to: sp.get("to") ?? undefined,
    cursor: sp.get("cursor") ?? undefined,
    limit: sp.get("limit") ? Number(sp.get("limit")) : undefined,
  });

  return NextResponse.json(result);
});
