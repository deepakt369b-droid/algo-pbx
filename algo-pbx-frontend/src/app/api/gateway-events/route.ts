import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
// Deliberate unsafeGlobalDb usage throughout this file (same reasoning as
// pjsip-provision.ts, admin/maintenance/prune/route.ts, and
// admin/gateway-sites/connectivity-check/route.ts): the Dinstar syslog
// forwarder posts here with a shared secret, no session, and no single
// tenant — a batch of lines can in principle span multiple tenants' sites.
// Each line's `sourceIp` is resolved against GatewaySite.gatewayLanIp /
// tunnelIp below to attribute its GatewayEvent row to the right tenant.
import { unsafeGlobalDb as db } from "@/lib/db";
import { parseGatewaySyslogLine } from "@/lib/dinstar/syslog-parse";
import { detectCriticalAlerts, isAlertDue, isConfiguredSecret } from "@/lib/dinstar/gateway-alerts";
import { getSetting } from "@/lib/settings/service";
import { sendGatewayAlertEmail } from "@/lib/mail/resend";

export const dynamic = "force-dynamic";

// POST /api/gateway-events — ingest for scripts/gateway-syslog-listener.ts,
// the dumb UDP forwarder for the Dinstar gateway's Diagnostic -> Syslog
// feature (see that script's header for the still-unresolved "no traffic
// observed yet" caveat as of 2026-09-03). Same shared-bearer-secret pattern
// as CDR_INGEST_SECRET (src/app/api/cdr/route.ts) and PRUNE_SECRET
// (admin/maintenance/prune/route.ts) — a machine-to-machine caller with no
// user session, compared with timingSafeEqual rather than `===` so a
// mistimed guess can't be used to brute-force the secret one byte at a
// time. The listener reaches this over loopback only (network_mode: host,
// see docker-compose.yml's gateway-syslog-listener service), never a
// published port.
function isAuthorizedIngest(req: NextRequest): boolean {
  const expected = process.env.GATEWAY_INGEST_SECRET;
  if (!expected) return false; // fail closed if the secret was never configured
  const provided = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

const LineSchema = z.object({
  raw: z.string().max(8192),
  sourceIp: z.string().max(64),
  receivedAt: z.string().datetime({ offset: true }).optional(),
});
const BodySchema = z.object({
  lines: z.array(LineSchema).max(500),
});

export async function POST(request: NextRequest) {
  if (!isAuthorizedIngest(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }
  if (parsed.data.lines.length === 0) {
    return NextResponse.json({ ok: true, ingested: 0 });
  }

  // Resolve which tenant each line's sourceIp belongs to, via the
  // GatewaySite it matches (checking both the LAN IP the gateway posts
  // syslog FROM and the OpenVPN tunnel IP, in case the listener sees the
  // tunneled address instead) — a plain map lookup, not a per-line query,
  // since a batch is at most 500 lines but almost always all from the same
  // handful of sites.
  const uniqueSourceIps = [...new Set(parsed.data.lines.map((l) => l.sourceIp))];
  const matchingSites = await db.gatewaySite.findMany({
    where: { OR: [{ gatewayLanIp: { in: uniqueSourceIps } }, { tunnelIp: { in: uniqueSourceIps } }] },
    select: { gatewayLanIp: true, tunnelIp: true, tenantId: true },
  });
  const tenantIdBySourceIp = new Map<string, string>();
  for (const site of matchingSites) {
    tenantIdBySourceIp.set(site.gatewayLanIp, site.tenantId);
    if (site.tunnelIp) tenantIdBySourceIp.set(site.tunnelIp, site.tenantId);
  }
  // A sourceIp matching no known GatewaySite (e.g. the site hasn't been
  // registered in /admin/connectivity yet) falls back to the earliest-
  // created Tenant — same single-tenant-today reasoning documented in
  // admin/maintenance/prune/route.ts's resolveDefaultTenantId() — rather
  // than silently dropping the event, since this data still has real
  // diagnostic value even if it can't be attributed precisely yet.
  let defaultTenantId: string | null | undefined;
  async function resolveTenantId(sourceIp: string): Promise<string | null> {
    const known = tenantIdBySourceIp.get(sourceIp);
    if (known) return known;
    if (defaultTenantId === undefined) {
      const tenant = await db.tenant.findFirst({ orderBy: { createdAt: "asc" }, select: { id: true } });
      defaultTenantId = tenant?.id ?? null;
    }
    return defaultTenantId;
  }

  // The listener is a dumb forwarder — all parsing/classification happens
  // here, server-side, so the taxonomy in syslog-parse.ts can be corrected
  // and redeployed without touching the small, hard-to-crash UDP intake
  // process facing untrusted network input.
  const rows = (
    await Promise.all(
      parsed.data.lines.map(async (line) => {
        const event = parseGatewaySyslogLine(line.raw);
        const tenantId = await resolveTenantId(line.sourceIp);
        if (!tenantId) return null; // no Tenant exists yet at all — nothing sensible to attribute this to
        return {
          tenantId,
          receivedAt: line.receivedAt ? new Date(line.receivedAt) : undefined,
          deviceTime: event.deviceTime,
          sourceIp: line.sourceIp,
          severity: event.severity,
          category: event.category,
          eventType: event.eventType,
          port: event.port,
          message: event.message,
          raw: event.raw,
        };
      })
    )
  ).filter((r): r is NonNullable<typeof r> => r !== null);

  const result = rows.length > 0 ? await db.gatewayEvent.createMany({ data: rows }) : { count: 0 };

  // Alert on real-time ingestion rather than only when an admin happens to
  // have /admin/system open — see gateway-alerts.ts's header for the
  // known "first occurrence, not burst/duration" simplification this
  // first version ships with.
  await triggerAlerts(rows);

  return NextResponse.json({ ok: true, ingested: result.count });
}

// AuditLog.actorId is a real, enforced FK to User — there is no "system"
// actor concept in this schema. Same resolution the prune route's own cron
// path uses: attribute machine-triggered rows to the earliest-created
// ADMIN account rather than inventing one — but resolved PER TENANT here
// (with a global fallback), since this route can now be writing rows for
// more than one tenant in a single run and an admin in tenant A is not a
// valid actor to blame for an alert that belongs to tenant B.
const systemActorCache = new Map<string, string | null>();
async function resolveSystemActorId(tenantId: string): Promise<string | null> {
  if (systemActorCache.has(tenantId)) return systemActorCache.get(tenantId) ?? null;
  let admin = await db.user.findFirst({ where: { role: "ADMIN", tenantId }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (!admin) {
    // Fallback: this tenant has no ADMIN of its own yet — attribute to the
    // earliest ADMIN anywhere rather than silently dropping the alert.
    admin = await db.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" }, select: { id: true } });
  }
  systemActorCache.set(tenantId, admin?.id ?? null);
  return admin?.id ?? null;
}

async function triggerAlerts(rows: { tenantId: string; eventType: string | null; port: number | null; message: string }[]): Promise<void> {
  // detectCriticalAlerts() is typed against the fixed IngestedEventForAlerting
  // shape (src/lib/dinstar/gateway-alerts.ts) — a shared lib file out of
  // this wave's scope to touch — so `tenantId` doesn't survive through its
  // return type even though the actual objects still carry it at runtime.
  // Rebuilt here via the exact same "first occurrence per eventType" rule
  // that function uses internally, so this map agrees with which row it
  // picked as `event` for each alert.
  const tenantIdByEventType = new Map<string, string>();
  for (const row of rows) {
    if (row.eventType && !tenantIdByEventType.has(row.eventType)) tenantIdByEventType.set(row.eventType, row.tenantId);
  }

  const alerts = detectCriticalAlerts(rows);
  if (alerts.length === 0) return;

  const alertEmail = await getSetting("GATEWAY_ALERT_EMAIL");
  const resendConfigured = isConfiguredSecret(await getSetting("RESEND_API_KEY"));

  for (const { type, event } of alerts) {
    const tenantId = tenantIdByEventType.get(type);
    if (!tenantId) continue; // should be unreachable — every alert type came from some row above

    const actorId = await resolveSystemActorId(tenantId);
    if (!actorId) continue; // no admin exists anywhere yet to attribute/notify — nothing sensible to do

    const lastSent = await db.auditLog.findFirst({
      where: { tenantId, action: "gateway_alert.sent", metadata: { path: ["eventType"], equals: type } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    if (!isAlertDue(lastSent?.createdAt ?? null)) continue;

    let emailSent = false;
    let emailError: string | undefined;
    if (alertEmail && resendConfigured) {
      try {
        await sendGatewayAlertEmail(alertEmail, { type, message: event.message, port: event.port });
        emailSent = true;
      } catch (err) {
        emailError = err instanceof Error ? err.message : String(err);
      }
    }

    await db.auditLog.create({
      data: {
        tenantId,
        action: "gateway_alert.sent",
        actorId,
        metadata: {
          eventType: type,
          message: event.message,
          port: event.port,
          emailSent,
          emailBlockedOnSecret: !alertEmail || !resendConfigured,
          emailError,
        },
      },
    });
  }
}
