import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { NextRequest, NextResponse } from "next/server";
import { unsafeGlobalDb } from "@/lib/db";
import { requireAdminSession } from "@/lib/auth-guard";
import { getSetting } from "@/lib/settings/service";
import { sendGatewayAlertEmail } from "@/lib/mail/resend";
import { isAlertDue, isConfiguredSecret, type SiteCriticalAlertType } from "@/lib/dinstar/gateway-alerts";
import { transports } from "@/lib/connectivity/transports";
import { checkAndFailoverTenant } from "@/lib/connectivity/failover";
import type { GatewaySite } from "@prisma/client";

export const dynamic = "force-dynamic";

// POST /api/admin/gateway-sites/connectivity-check — the 60s cron target
// (OpenVPN/Headscale/connectivity task, Node F). Same shared-bearer-secret
// + dual-auth pattern as PRUNE_SECRET/SMS_POLL_SECRET
// (src/app/api/admin/maintenance/prune/route.ts) — a machine-triggered
// caller with no user session, or an interactive admin session for a
// manual "check now" click. Crontab line documented in .env.example.
function isAuthorizedCronRequest(req: NextRequest): boolean {
  const expected = process.env.CONNECTIVITY_CHECK_SECRET;
  if (!expected) return false; // fail closed if the secret was never configured
  const provided = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Where the connectivity-check route reads OpenVPN's status-version 2 log
// from — see docker-compose.yml's `web` service comment for the exact
// volume-subpath mount that puts this ONE file (never the rest of the PKI
// directory) here. A missing/unreadable file reads as "no OpenVPN client
// data available," never a crash — this is expected and normal before
// openvpn-server's PKI is initialized and before G2's cutover, not just an
// edge case to tolerate.
const OPENVPN_STATUS_LOG_PATH = process.env.OPENVPN_STATUS_LOG_PATH || "/app/openvpn-status.log";

async function readOpenVpnStatusLog(): Promise<string | null> {
  try {
    return await readFile(OPENVPN_STATUS_LOG_PATH, "utf8");
  } catch {
    return null;
  }
}

interface CheckResult {
  status: "UP" | "DEGRADED" | "DOWN" | "UNKNOWN";
  lastHandshakeAt: Date | null;
  lastReachableAt: Date | null;
  alertType: SiteCriticalAlertType | null;
}

// Dispatches through the transport registry (src/lib/connectivity/
// transports) instead of an inline switch — a fifth transport is a new
// file under that directory plus one line in its index, not a change
// here. Behavior for every existing transport is unchanged: TAILSCALE
// stays UNKNOWN/unmonitored, HEADSCALE stays UNKNOWN unless an API key is
// configured, OPENVPN's status-log + TCP-probe logic is moved (not
// rewritten) into openvpn.ts.
async function checkSite(site: GatewaySite, statusLogContent: string | null, now: Date): Promise<CheckResult> {
  const transport = transports[site.transport];
  const result = await transport.probe(site, { statusLogContent, now });
  return {
    status: result.status,
    lastHandshakeAt: result.lastHandshakeAt,
    lastReachableAt: result.lastReachableAt,
    alertType: result.alertType,
  };
}

async function resolveSystemActor(): Promise<{ id: string } | null> {
  // No "system" actor concept in this schema — same resolution the prune
  // route and the syslog ingest route's triggerAlerts() already use:
  // attribute machine-triggered rows to the earliest-created ADMIN account.
  return unsafeGlobalDb.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" }, select: { id: true } });
}

async function maybeSendAlert(site: GatewaySite, alertType: SiteCriticalAlertType, message: string, actorId: string): Promise<void> {
  const lastSent = await unsafeGlobalDb.auditLog.findFirst({
    where: { action: "gateway_alert.sent", targetId: site.id, metadata: { path: ["eventType"], equals: alertType } },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  if (!isAlertDue(lastSent?.createdAt ?? null)) return;

  const alertEmail = await getSetting("GATEWAY_ALERT_EMAIL");
  const resendConfigured = isConfiguredSecret(await getSetting("RESEND_API_KEY"));

  let emailSent = false;
  let emailError: string | undefined;
  if (alertEmail && resendConfigured) {
    try {
      await sendGatewayAlertEmail(alertEmail, { type: alertType, message, port: null });
      emailSent = true;
    } catch (err) {
      emailError = err instanceof Error ? err.message : String(err);
    }
  }

  await unsafeGlobalDb.auditLog.create({
    data: {
      // unsafeGlobalDb has no tenant-scoping extension to auto-inject
      // tenantId (unlike TenantClient elsewhere) — this route genuinely
      // operates across every tenant's sites in one run, so the tenantId
      // for each written row is taken explicitly from the site it's about.
      tenantId: site.tenantId,
      action: "gateway_alert.sent",
      actorId,
      targetId: site.id,
      metadata: { eventType: alertType, message, siteName: site.name, emailSent, emailBlockedOnSecret: !alertEmail || !resendConfigured, emailError },
    },
  });
}

export async function POST(request: NextRequest) {
  let actorId: string;
  if (isAuthorizedCronRequest(request)) {
    const systemActor = await resolveSystemActor();
    if (!systemActor) {
      return NextResponse.json({ error: "No ADMIN account exists yet to attribute this run to." }, { status: 500 });
    }
    actorId = systemActor.id;
  } else {
    const guard = await requireAdminSession();
    if ("response" in guard) return guard.response;
    actorId = guard.session.user.id;
  }

  // Deliberate unsafeGlobalDb exception (see this route's dual-auth header
  // comment): this poller must see and update EVERY tenant's GatewaySite
  // rows in one run regardless of which caller (cron secret, or an
  // interactive admin session scoped to just their own tenant) triggered
  // it — a tenant-scoped `db` from the admin-session branch would silently
  // skip every other tenant's sites. GatewaySite is genuinely per-tenant
  // data, but this specific route's job is cross-tenant by design.
  const sites = await unsafeGlobalDb.gatewaySite.findMany();
  const statusLogContent = await readOpenVpnStatusLog();
  const now = new Date();

  const results: { siteId: string; name: string; status: CheckResult["status"] }[] = [];

  for (const site of sites) {
    const result = await checkSite(site, statusLogContent, now);
    if (result.status === "UNKNOWN") {
      results.push({ siteId: site.id, name: site.name, status: "UNKNOWN" });
      continue; // TAILSCALE (unmonitored) or HEADSCALE (gap, see checkHeadscaleNodeOnline) — leave GatewaySite untouched
    }

    const wasUnhealthy = site.status === "DOWN" || site.status === "DEGRADED";
    const isNowHealthy = result.status === "UP";

    await unsafeGlobalDb.gatewaySite.update({
      where: { id: site.id },
      data: {
        status: result.status,
        lastHandshakeAt: result.lastHandshakeAt ?? undefined,
        lastReachableAt: result.lastReachableAt ?? undefined,
      },
    });

    if (result.alertType) {
      await maybeSendAlert(site, result.alertType, `Site "${site.name}" — ${result.alertType.replace(/[._]/g, " ")}`, actorId);
    } else if (wasUnhealthy && isNowHealthy) {
      // Recovery — a status-based transition, not an event, so there's no
      // "next occurrence" to naturally clear the active-alert view the way
      // GatewayEvent-driven alerts self-expire out of their rate-limit
      // window. Write an explicit resolving row for the audit trail; the
      // /api/admin/gateway-alerts route's "active" query for sites reads
      // live GatewaySite.status directly (see that route), so it stops
      // showing this site the moment the update above lands — this
      // AuditLog row is the historical record, not what un-shows the
      // banner.
      await unsafeGlobalDb.auditLog.create({
        data: {
          // Same reasoning as maybeSendAlert()'s auditLog.create above —
          // unsafeGlobalDb has no tenant-scoping extension to auto-inject
          // tenantId, so it's taken explicitly from the site this recovery
          // row is about.
          tenantId: site.tenantId,
          action: "gateway_alert.resolved",
          actorId,
          targetId: site.id,
          metadata: { siteName: site.name, previousStatus: site.status },
        },
      });
    }

    results.push({ siteId: site.id, name: site.name, status: result.status });
  }

  // W3 — failover supervisor (connectivity plan §3.2), run once per
  // tenant that has gateway sites, AFTER every site's status write above
  // has landed (selectPrimarySite needs this run's fresh data, not last
  // run's). Never run per-site — a per-tenant decision needs the whole
  // tenant's site set to pick the right primary.
  const tenantIds = [...new Set(sites.map((s) => s.tenantId))];
  for (const tenantId of tenantIds) {
    await checkAndFailoverTenant(tenantId, actorId);
  }

  return NextResponse.json({ ok: true, checked: results.length, results });
}
