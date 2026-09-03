import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireStaffSession } from "@/lib/auth-guard";
import { ALERT_RATE_LIMIT_MS, CRITICAL_ALERT_TYPES } from "@/lib/dinstar/gateway-alerts";

export const dynamic = "force-dynamic";

// GET /api/admin/gateway-alerts — the dedicated alert banner's data
// source (src/components/admin-shell/gateway-alert-banner.tsx). NOT
// wired into the existing top-bar HealthPill/system-health check —
// that indicator is already pinned "fail" by the unrelated,
// pre-existing DINSTAR_SMS_USERNAME/PASSWORD `change-me` placeholder
// (see handoff.md), so a real gateway alert routed through it would be
// invisible on day one. This is a second, separate signal.
//
// "Active" here means a critical-type GatewayEvent within the same
// window email alerting rate-limits on (see gateway-alerts.ts) — this is
// a live snapshot of recent gateway state for the banner, independent of
// whether an email actually fired for it (that's tracked separately via
// AuditLog "gateway_alert.sent" rows, see the ingest route).
export async function GET() {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const since = new Date(Date.now() - ALERT_RATE_LIMIT_MS);
  const events = await db.gatewayEvent.findMany({
    where: { eventType: { in: [...CRITICAL_ALERT_TYPES] }, receivedAt: { gte: since } },
    orderBy: { receivedAt: "desc" },
  });

  // One entry per distinct type, most recent first — the banner shows
  // "what's currently wrong," not a duplicate row per repeated event.
  const seen = new Set<string>();
  const active = events.filter((e) => {
    if (!e.eventType || seen.has(e.eventType)) return false;
    seen.add(e.eventType);
    return true;
  });

  return NextResponse.json({ active });
}
