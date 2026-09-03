import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
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

  // The listener is a dumb forwarder — all parsing/classification happens
  // here, server-side, so the taxonomy in syslog-parse.ts can be corrected
  // and redeployed without touching the small, hard-to-crash UDP intake
  // process facing untrusted network input.
  const rows = parsed.data.lines.map((line) => {
    const event = parseGatewaySyslogLine(line.raw);
    return {
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
  });

  const result = await db.gatewayEvent.createMany({ data: rows });

  // Alert on real-time ingestion rather than only when an admin happens to
  // have /admin/system open — see gateway-alerts.ts's header for the
  // known "first occurrence, not burst/duration" simplification this
  // first version ships with.
  await triggerAlerts(rows);

  return NextResponse.json({ ok: true, ingested: result.count });
}

async function triggerAlerts(rows: { eventType: string | null; port: number | null; message: string }[]): Promise<void> {
  const alerts = detectCriticalAlerts(rows);
  if (alerts.length === 0) return;

  // AuditLog.actorId is a real, enforced FK to User — there is no "system"
  // actor concept in this schema. Same resolution the prune route's own
  // cron path uses: attribute machine-triggered rows to the earliest-
  // created ADMIN account rather than inventing one.
  const systemActor = await db.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" }, select: { id: true } });
  if (!systemActor) return; // no admin exists yet to attribute/notify — nothing sensible to do

  const alertEmail = await getSetting("GATEWAY_ALERT_EMAIL");
  const resendConfigured = isConfiguredSecret(await getSetting("RESEND_API_KEY"));

  for (const { type, event } of alerts) {
    const lastSent = await db.auditLog.findFirst({
      where: { action: "gateway_alert.sent", metadata: { path: ["eventType"], equals: type } },
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
        action: "gateway_alert.sent",
        actorId: systemActor.id,
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
