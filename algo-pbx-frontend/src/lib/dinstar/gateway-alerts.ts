// Which just-ingested Dinstar gateway events (see api/gateway-events's
// ingest route) are alert-worthy, and the DB-free half of the per-type
// email rate limit. Pure functions, no Prisma import — same
// unit-testable-without-a-database convention as contact-ownership.ts and
// deal-ownership.ts.
//
// KNOWN SIMPLIFICATION (first version — see the plan's "a first version of
// that pipeline" framing): the plan describes threshold rules ("FORBID
// CALL burst", "port unregistered > 5 min") that need cross-request
// historical state this per-batch detector doesn't have. This version
// alerts on the FIRST occurrence of each critical event type within an
// ingest batch rather than waiting for a burst/duration threshold — safer
// to over-notify than under-notify before real event volume from the
// gateway is understood, and the thresholds can be tightened once it is.

// The last three values (OpenVPN/Headscale/connectivity task, Node F) are
// SITE-status-derived, not syslog-event-derived like the first three —
// they never appear as a GatewayEvent.eventType, only as the `type` this
// module's own site-alert helpers below produce. Widened onto the same
// union (rather than a parallel type) so `sendGatewayAlertEmail`'s `type`
// param, AuditLog's `metadata.eventType`, and the admin alert banner's
// rendering stay one shared taxonomy instead of two that could drift.
export type CriticalAlertType =
  | "gsm.forbid_call"
  | "gsm.port_unregistered"
  | "sip.trunk_unreachable"
  | "vpn.handshake_stale"
  | "vpn.tunnel_unreachable"
  | "headscale.node_offline";

// Exported (not just the Set below) so /api/admin/gateway-alerts' "active
// alerts" query can filter on the same list without a second hardcoded copy
// silently drifting from this one if the taxonomy is ever widened.
export const CRITICAL_ALERT_TYPES: readonly CriticalAlertType[] = [
  "gsm.forbid_call",
  "gsm.port_unregistered",
  "sip.trunk_unreachable",
  "vpn.handshake_stale",
  "vpn.tunnel_unreachable",
  "headscale.node_offline",
];

// Site-connectivity-alert-only subset — the connectivity-check route
// (OpenVPN/Headscale/connectivity task) only ever needs to detect these
// three, never the GSM/SIP ones above (those come from ingested syslog
// events, a completely different data source: GatewayEvent rows, not
// GatewaySite rows).
export type SiteCriticalAlertType = "vpn.handshake_stale" | "vpn.tunnel_unreachable" | "headscale.node_offline";

const CRITICAL_TYPES: ReadonlySet<string> = new Set<CriticalAlertType>(CRITICAL_ALERT_TYPES);

export interface IngestedEventForAlerting {
  eventType: string | null;
  port: number | null;
  message: string;
}

/** Every distinct critical alert type present in a just-ingested batch,
 * each paired with the first matching event (for the alert's message/port
 * context). Order follows first occurrence in the batch. */
export function detectCriticalAlerts(
  events: IngestedEventForAlerting[]
): { type: CriticalAlertType; event: IngestedEventForAlerting }[] {
  const seen = new Set<string>();
  const result: { type: CriticalAlertType; event: IngestedEventForAlerting }[] = [];
  for (const event of events) {
    if (!event.eventType || !CRITICAL_TYPES.has(event.eventType) || seen.has(event.eventType)) continue;
    seen.add(event.eventType);
    result.push({ type: event.eventType as CriticalAlertType, event });
  }
  return result;
}

// getSetting("RESEND_API_KEY") resolves the literal string "change-me" as a
// truthy, non-empty value when the .env placeholder has never been rotated
// (confirmed live on this deployment — see handoff.md) — Boolean(value)
// alone would treat that as "configured" and attempt a real Resend API call
// that can only fail. Narrow, named check so the ingest route's
// resendConfigured gate actually matches the plan's "ship in-app alerts
// only, record blocked-on-secret" requirement instead of silently sending
// one doomed HTTP request per critical alert type.
export function isConfiguredSecret(value: string | undefined): boolean {
  return Boolean(value) && value !== "change-me";
}

export const ALERT_RATE_LIMIT_MS = 15 * 60 * 1000;

/** True if enough time has passed since the last alert of this type to
 * send another one. `lastSentAt` is null when no prior alert is on
 * record. Pure — the caller looks up lastSentAt (from AuditLog, see the
 * ingest route) and `now` is injectable for tests. */
export function isAlertDue(lastSentAt: Date | null, now: Date = new Date()): boolean {
  if (!lastSentAt) return true;
  return now.getTime() - lastSentAt.getTime() >= ALERT_RATE_LIMIT_MS;
}

// --- Site connectivity (OpenVPN/Headscale/connectivity task, Node F) ---
// Below this point: pure decision logic for the 60s connectivity-check
// poller (POST /api/admin/gateway-sites/connectivity-check). Kept in this
// same file rather than a parallel one, per the task's "extend, don't
// fork" instruction — one shared taxonomy/rate-limit/decision module for
// every gateway alert this app raises, event-driven or site-driven.

// 3 minutes — matches the plan's own stated "green" threshold for the
// connectivity page's status coloring, so the poller's alert decision and
// the UI's display threshold never silently disagree.
export const SITE_STALE_HANDSHAKE_MS = 3 * 60 * 1000;

/** True if a site's last recorded OpenVPN handshake is missing or older
 * than the stale threshold. Pure — `now` is injectable for tests. */
export function isHandshakeStale(lastHandshakeAt: Date | null, now: Date = new Date()): boolean {
  if (!lastHandshakeAt) return true;
  return now.getTime() - lastHandshakeAt.getTime() > SITE_STALE_HANDSHAKE_MS;
}

export interface SiteConnectivityCheckInput {
  transport: "TAILSCALE" | "OPENVPN" | "HEADSCALE";
  /** Was this site's CN found in the OpenVPN status log (OPENVPN sites) or
   * reported online by `headscale nodes list` (HEADSCALE sites)? Ignored
   * for TAILSCALE sites — this poller doesn't monitor the legacy path. */
  connectedInStatusSource: boolean;
  lastHandshakeAt: Date | null;
  /** Did the tunnel-IP ping succeed? `null` when there's no tunnelIp yet
   * to ping (e.g. a site whose cert was generated but never actually
   * pushed/connected) — treated as "can't confirm," not as a failure, so
   * a freshly-created site doesn't immediately alert. */
  pingOk: boolean | null;
  now?: Date;
}

/** The single decision point for "is this site currently alert-worthy,
 * and if so as which type" — used by the poller to both update
 * GatewaySite.status and decide whether to raise/clear an alert. Returns
 * null for TAILSCALE sites (out of scope for this poller) and for any
 * site that looks healthy. Pure, no I/O — the caller supplies every input
 * from its own DB/status-log/ping reads. */
export function classifySiteAlert(input: SiteConnectivityCheckInput): SiteCriticalAlertType | null {
  const now = input.now ?? new Date();
  if (input.transport === "TAILSCALE") return null; // legacy path, not monitored by this poller
  if (input.transport === "HEADSCALE") {
    return input.connectedInStatusSource ? null : "headscale.node_offline";
  }
  // OPENVPN
  if (!input.connectedInStatusSource || isHandshakeStale(input.lastHandshakeAt, now)) {
    return "vpn.handshake_stale";
  }
  if (input.pingOk === false) {
    return "vpn.tunnel_unreachable";
  }
  return null;
}

/** Strict IPv4 dotted-quad validator — a basic sanity/format guard before
 * a `tunnelIp` value is ever used to open a network connection (the
 * connectivity-check route's TCP-probe), same defense-in-depth philosophy
 * as bridge-watch.sh's own allowlist check on `GatewaySite.name`/CN before
 * it touches easyrsa. Deliberately narrow (IPv4 only — the tunnel subnet
 * is always IPv4) and range-checks each octet rather than trusting a
 * loose regex. */
export function isValidIPv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (part.length > 1 && part.startsWith("0")) return false; // no leading zeros (e.g. "010" ambiguity)
    const n = Number(part);
    return n >= 0 && n <= 255;
  });
}
