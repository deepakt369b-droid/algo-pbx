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
// "Active" here means EITHER a critical-type GatewayEvent within the same
// window email alerting rate-limits on (see gateway-alerts.ts) — this is
// a live snapshot of recent gateway state for the banner, independent of
// whether an email actually fired for it (that's tracked separately via
// AuditLog "gateway_alert.sent" rows, see the ingest route) — OR a
// GatewaySite currently sitting at DOWN/DEGRADED (OpenVPN/Headscale/
// connectivity task, Node F). Sites are a live STATE, not a windowed
// EVENT stream, so they're read directly off GatewaySite.status rather
// than via the same receivedAt-window query the event-driven alerts use
// — the 60s connectivity-check poller is what keeps that status current,
// and a site recovering simply stops matching this query on its next
// successful check, no separate "resolved" bookkeeping needed here (see
// that route's own comment on why it still writes a resolving AuditLog
// row anyway, for the historical trail).
export async function GET() {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const since = new Date(Date.now() - ALERT_RATE_LIMIT_MS);
  const [events, unhealthySites] = await Promise.all([
    db.gatewayEvent.findMany({
      where: { eventType: { in: [...CRITICAL_ALERT_TYPES] }, receivedAt: { gte: since } },
      orderBy: { receivedAt: "desc" },
    }),
    db.gatewaySite.findMany({
      where: { status: { in: ["DOWN", "DEGRADED"] } },
      orderBy: { updatedAt: "desc" },
    }),
  ]);

  // One entry per distinct type, most recent first — the banner shows
  // "what's currently wrong," not a duplicate row per repeated event.
  const seen = new Set<string>();
  const eventAlerts = events.filter((e) => {
    if (!e.eventType || seen.has(e.eventType)) return false;
    seen.add(e.eventType);
    return true;
  });

  // Site alerts mapped onto the SAME shape the banner already renders
  // (id/eventType/message/port/receivedAt) — deliberately not a second,
  // differently-shaped array; the banner component needs no changes to
  // display these alongside event-driven ones.
  const siteAlerts = unhealthySites.map((site) => ({
    id: site.id,
    eventType: site.status === "DOWN" ? (site.transport === "HEADSCALE" ? "headscale.node_offline" : "vpn.tunnel_unreachable") : "vpn.handshake_stale",
    message: `Site "${site.name}" is ${site.status.toLowerCase()}`,
    port: null,
    receivedAt: site.updatedAt.toISOString(),
  }));

  return NextResponse.json({ active: [...eventAlerts, ...siteAlerts] });
}
