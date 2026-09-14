import { NextRequest, NextResponse } from "next/server";
import { unsafeGlobalDb as db } from "@/lib/db";
import { requirePlatformSession } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

// GET /api/platform/tenants/[id]/ai-usage — AI session count for the
// owner console's BillingTab (W7 task 5: "add AI usage/session count
// display"). New route, same reasoning as the sibling routes flagged in
// src/app/api/admin/ai/agents/**'s header: billing-tab.tsx has no existing
// data source for AiCallSession (SerialisedTenantDetail's `counts` doesn't
// carry it, and that shape belongs to src/lib/platform/tenant-detail.ts,
// out of this node's file list), so a minimal read-only endpoint is added
// here instead of touching that file.
//
// "Simple count query is fine, doesn't need to be exact billing-grade" per
// the task — this counts by AiCallSession.createdAt within the last 30
// days as a stand-in "this period" window (the platform's billing cycle
// isn't a fixed calendar month; see billing-tab.tsx's own "manual-first"
// header), not by matching against Tenant.paidUntil.
const PERIOD_DAYS = 30;

export const GET = withApiErrorHandler(async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const guard = await requirePlatformSession();
  if ("response" in guard) return guard.response;

  const tenant = await db.tenant.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  const since = new Date(Date.now() - PERIOD_DAYS * 24 * 60 * 60 * 1000);
  const [sessionCount, agentCount] = await Promise.all([
    db.aiCallSession.count({ where: { tenantId: tenant.id, createdAt: { gte: since } } }),
    db.aiAgent.count({ where: { tenantId: tenant.id } }),
  ]);

  return NextResponse.json({ sessionCount, agentCount, periodDays: PERIOD_DAYS });
});
