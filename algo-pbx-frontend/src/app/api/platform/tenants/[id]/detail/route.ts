import { NextRequest, NextResponse } from "next/server";
import { loadTenantDetail } from "@/lib/platform/tenant-detail";
import { requirePlatformSession } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

// GET /api/platform/tenants/[id]/detail — the same loadTenantDetail() shape
// the tenant detail PAGE renders server-side
// (src/app/platform/(console)/tenants/[id]/page.tsx), exposed as JSON so the
// tenant-list row's management modal (W1, tenant-manage-modal.tsx) can fetch
// it client-side and reuse the exact same <TenantDetailTabs/> component
// rather than re-implementing its panels. `NextResponse.json()` serialises
// Dates to ISO strings the same way that page's
// `JSON.parse(JSON.stringify(detail))` does, so the two call sites produce
// an identical SerialisedTenantDetail shape by construction.
export const GET = withApiErrorHandler(async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const guard = await requirePlatformSession();
  if ("response" in guard) return guard.response;

  const detail = await loadTenantDetail(params.id);
  if (!detail) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  return NextResponse.json({ detail, role: guard.session.user.role });
});
