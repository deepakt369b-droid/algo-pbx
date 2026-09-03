import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import net from "node:net";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdminSession } from "@/lib/auth-guard";
import { getSetting } from "@/lib/settings/service";
import { sendGatewayAlertEmail } from "@/lib/mail/resend";
import { parseOpenVpnStatusLog, findClientByCommonName } from "@/lib/dinstar/openvpn-status-parse";
import {
  classifySiteAlert,
  isAlertDue,
  isConfiguredSecret,
  isValidIPv4,
  type SiteCriticalAlertType,
} from "@/lib/dinstar/gateway-alerts";
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

// TCP-connect reachability probe — deliberately NOT a shelled-out ICMP
// `ping`. Two real, verified-during-build reasons: (1) the `web` image
// (node:20-alpine, see algo-pbx-frontend/Dockerfile's `runner` stage) has
// no `ping` binary and no iputils package installed; (2) even with the
// binary present, ICMP sockets typically require root or CAP_NET_RAW
// inside a container, which this service deliberately doesn't have. An
// in-process TCP connect-and-close needs neither — matches the plan's own
// "ping + TCP:80 probe" wording via the TCP half, which is sufficient
// proof of reachability (the Dinstar's admin UI serves plain HTTP on 80
// only to 302-redirect to HTTPS — see device-client.ts's own comment — so
// even a redirect response, or just a successful SYN-ACK, confirms the
// device is live at this address).
function tcpProbe(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: timeoutMs });
    const finish = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

// HEADSCALE node-online checking is a KNOWN, DELIBERATE GAP in this first
// version — stated plainly rather than faked. Headscale's admin API
// (node list, online state) is configured Unix-socket-only inside the
// `headscale` container (see pbx_configs/headscale/config.yaml.template
// and docker-compose.yml's headscale service comment, Node C) — reachable
// today only via `docker exec`, which `web` cannot do (no Docker socket,
// a constraint this whole task's OpenVPN-bridge design was deliberately
// built around; see pbx_configs/openvpn/bridge-watch.sh's own header for
// the same reasoning applied to PKI operations). Wiring this properly
// needs either a network-reachable headscale admin endpoint with its own
// auth (a Node-C-scope config decision, not this route's to make
// unilaterally) or an analogous Docker-socket-free bridge. Until then,
// HEADSCALE-transport sites are left at SiteConnectivityStatus.UNKNOWN by
// this poller — never silently reported as UP or DOWN without a real
// check behind it.
async function checkHeadscaleNodeOnline(_nodeName: string): Promise<boolean | null> {
  return null; // null = "not checked," distinct from a real true/false result
}

interface CheckResult {
  status: "UP" | "DEGRADED" | "DOWN" | "UNKNOWN";
  lastHandshakeAt: Date | null;
  lastReachableAt: Date | null;
  alertType: SiteCriticalAlertType | null;
}

async function checkSite(site: GatewaySite, statusLogContent: string | null, now: Date): Promise<CheckResult> {
  if (site.transport === "TAILSCALE") {
    // Legacy path — not monitored by this poller at all (it has its own
    // long-standing, separate reachability story via the Tailscale mesh
    // itself). Leaving GatewaySite.status untouched for these rows.
    return { status: "UNKNOWN", lastHandshakeAt: site.lastHandshakeAt, lastReachableAt: site.lastReachableAt, alertType: null };
  }

  if (site.transport === "HEADSCALE") {
    const online = await checkHeadscaleNodeOnline(site.name);
    if (online === null) {
      return { status: "UNKNOWN", lastHandshakeAt: site.lastHandshakeAt, lastReachableAt: site.lastReachableAt, alertType: null };
    }
    const alertType = classifySiteAlert({ transport: "HEADSCALE", connectedInStatusSource: online, lastHandshakeAt: null, pingOk: null, now });
    return {
      status: alertType ? "DOWN" : "UP",
      lastHandshakeAt: site.lastHandshakeAt,
      lastReachableAt: online ? now : site.lastReachableAt,
      alertType,
    };
  }

  // OPENVPN
  const clients = statusLogContent ? parseOpenVpnStatusLog(statusLogContent) : [];
  const match = findClientByCommonName(clients, site.name);
  const lastHandshakeAt = match?.connectedSince ?? site.lastHandshakeAt;

  let pingOk: boolean | null = null;
  if (site.tunnelIp && isValidIPv4(site.tunnelIp)) {
    pingOk = await tcpProbe(site.tunnelIp, 80);
  }

  const alertType = classifySiteAlert({
    transport: "OPENVPN",
    connectedInStatusSource: Boolean(match),
    lastHandshakeAt,
    pingOk,
    now,
  });

  return {
    status: alertType === "vpn.handshake_stale" ? "DEGRADED" : alertType === "vpn.tunnel_unreachable" ? "DOWN" : "UP",
    lastHandshakeAt,
    lastReachableAt: pingOk ? now : site.lastReachableAt,
    alertType,
  };
}

async function resolveSystemActor(): Promise<{ id: string } | null> {
  // No "system" actor concept in this schema — same resolution the prune
  // route and the syslog ingest route's triggerAlerts() already use:
  // attribute machine-triggered rows to the earliest-created ADMIN account.
  return db.user.findFirst({ where: { role: "ADMIN" }, orderBy: { createdAt: "asc" }, select: { id: true } });
}

async function maybeSendAlert(site: GatewaySite, alertType: SiteCriticalAlertType, message: string, actorId: string): Promise<void> {
  const lastSent = await db.auditLog.findFirst({
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

  await db.auditLog.create({
    data: {
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

  const sites = await db.gatewaySite.findMany();
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

    await db.gatewaySite.update({
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
      await db.auditLog.create({
        data: {
          action: "gateway_alert.resolved",
          actorId,
          targetId: site.id,
          metadata: { siteName: site.name, previousStatus: site.status },
        },
      });
    }

    results.push({ siteId: site.id, name: site.name, status: result.status });
  }

  return NextResponse.json({ ok: true, checked: results.length, results });
}
