import type { Prisma } from "@prisma/client";
import { unsafeGlobalDb } from "@/lib/db";
import { tenantDb } from "@/lib/db-tenant";
import { getAmiClient } from "@/lib/ami-client";
import { cutoverToSite, type CutoverSiteInput } from "@/lib/dinstar/site-cutover";
import { sendGatewayAlertEmail } from "@/lib/mail/resend";
import { getSetting } from "@/lib/settings/service";

// W3 — the failover supervisor (connectivity plan §3.2). Called by the
// existing 60-second connectivity-check cron (see
// src/app/api/admin/gateway-sites/connectivity-check/route.ts) once per
// tenant, AFTER that route has finished writing every site's fresh
// status/lastHandshakeAt/lastReachableAt for this run. This module never
// probes anything itself — it only DECIDES, using data the poller (W2's
// transport registry) already refreshed, whether the tenant's live trunk
// should move to a better site, and if so, calls the already
// AMI-read-back-verified `cutoverToSite()` to do it. It does not
// reimplement any part of that function.

// Same threshold as src/components/connectivity/site-table.tsx's
// `effectiveDot()` — that file is a "use client" UI component on the
// do-not-touch list for this task, so its constant cannot be imported
// from here without editing it. Keep this value byte-for-byte identical
// (3 minutes) rather than defining a different threshold; if the UI's
// value ever changes, this one must change with it by hand.
const HANDSHAKE_FRESH_MS = 3 * 60 * 1000;

// A flapping tunnel must not re-point the trunk every cron tick (plan
// §3.2 point 3). Tracked on `GatewaySite.lastFailoverAt` — the column's
// own schema comment already documents it as doubling as this cooldown
// clock. 10 minutes per the plan. Scoped per TENANT, not per candidate
// site: ANY of the tenant's (enabled) sites having had a cutover — either
// as source or destination is irrelevant, only the timestamp write
// matters — within the window blocks ANY further automatic cutover for
// that tenant, regardless of which site would be the new destination.
// This prevents a multi-site flap (A -> B -> C across consecutive ticks)
// from sneaking past a cooldown that was previously keyed to each
// candidate's own, independently-null `lastFailoverAt`. No schema change
// needed — `GatewaySite.lastFailoverAt` already exists on every site;
// we simply check across all of them instead of just the selected one.
const FAILOVER_COOLDOWN_MS = 10 * 60 * 1000;

export interface FailoverSite {
  id: string;
  priority: number;
  enabled: boolean;
  status: "UP" | "DEGRADED" | "DOWN" | "UNKNOWN";
  lastHandshakeAt: Date | null;
  lastFailoverAt: Date | null;
  tunnelIp: string | null;
  gatewayLanIp: string;
  createdAt: Date;
}

export interface FailoverTenant {
  id: string;
  activeGatewaySiteId: string | null;
  failoverEnabled: boolean;
}

export type FailoverAction =
  | { type: "no_candidate" }
  | { type: "already_active"; primaryId: string }
  | { type: "failover_disabled"; primaryId: string }
  | { type: "cooldown"; primaryId: string }
  | { type: "call_in_progress"; primaryId: string }
  | { type: "cutover_succeeded"; primaryId: string; fromSiteId: string | null }
  | { type: "cutover_failed"; primaryId: string; error?: string };

export interface FailoverDeps {
  /** Injectable for tests; defaults to the real cutoverToSite. */
  cutoverToSite: typeof cutoverToSite;
  /** Whether a call is currently in progress on the Dinstar trunk.
   * Defaults to a real AMI CoreShowChannels check (see
   * checkActiveCallOnTrunk below). */
  hasActiveTrunkCall: () => Promise<boolean>;
  /** Writes the `connectivity.auto_failover` AuditLog row, the
   * `Tenant.activeGatewaySiteId` update, and the new primary's
   * `lastFailoverAt` stamp. Bundled into one dependency so tests can
   * assert all three happen together without a real Prisma client. */
  recordSuccessfulFailover: (input: {
    tenantId: string;
    actorId: string;
    fromSiteId: string | null;
    toSiteId: string;
    verified: boolean | undefined;
    now: Date;
  }) => Promise<void>;
  recordFailedFailover: (input: { tenantId: string; actorId: string; toSiteId: string; error?: string }) => Promise<void>;
  /** Notifies a human every time an automatic cutover succeeds — silently
   * moving a production trunk is not acceptable (plan §3.2 point 3). */
  sendFailoverAlert: (input: { tenantId: string; toSiteId: string; verified: boolean | undefined }) => Promise<void>;
  now: () => Date;
}

function isFresh(lastHandshakeAt: Date | null, now: Date): boolean {
  return lastHandshakeAt !== null && now.getTime() - lastHandshakeAt.getTime() < HANDSHAKE_FRESH_MS;
}

/**
 * Pure selection logic (no I/O) — the lowest-`priority` enabled site that
 * is `UP` and has a fresh handshake, per plan §3.2 point 1. `null` means
 * no site currently qualifies as primary; callers must do nothing in that
 * case rather than fail over to a non-working site. Ties on `priority`
 * broken by `createdAt` ascending (oldest wins) for a stable, predictable
 * choice among sites an admin never bothered to distinguish.
 *
 * NOTE: this only answers "which healthy site would be the best pick right
 * now" — it does NOT decide whether the trunk should actually move there.
 * That decision (whether the CURRENTLY ACTIVE site is unhealthy enough to
 * warrant moving away from it at all) is made by `runFailoverForTenant`,
 * which is the only place fail-back-prevention is enforced.
 */
export function selectPrimarySite(sites: FailoverSite[], now: Date): FailoverSite | null {
  const candidates = sites
    .filter((s) => s.enabled && s.status === "UP" && isFresh(s.lastHandshakeAt, now))
    .sort((a, b) => a.priority - b.priority || a.createdAt.getTime() - b.createdAt.getTime());
  return candidates[0] ?? null;
}

/** True if ANY of the tenant's (enabled) sites had a cutover recorded
 * within the cooldown window — see the `FAILOVER_COOLDOWN_MS` comment for
 * why this is tenant-scoped rather than keyed to a single candidate's own
 * `lastFailoverAt`. */
function tenantInFailoverCooldown(sites: FailoverSite[], now: Date): boolean {
  return sites.some((s) => s.lastFailoverAt !== null && now.getTime() - s.lastFailoverAt.getTime() < FAILOVER_COOLDOWN_MS);
}

/**
 * The supervisor's core decision + orchestration, for exactly one tenant.
 * Assumes `sites` already reflects this cron run's freshly written
 * statuses (the caller reads them after the connectivity-check loop that
 * wrote them, or passes an equivalent snapshot in tests).
 *
 * Trigger condition (plan §3.2 point 4 — fail-back is not automatic):
 * this function only ever moves the trunk when the CURRENTLY ACTIVE site
 * is unhealthy (not `UP`, not enabled, not found among the sites, or its
 * handshake isn't fresh) AND a different, healthy site is available. If
 * the active site is currently healthy, this is a no-op regardless of
 * whether an even-better-priority site has also become healthy — a
 * flapping better-priority site can no longer yank the trunk back and
 * forth just because it briefly looks good. Once the trunk has moved to
 * a lower-priority site, it stays there — recovering the original
 * primary does NOT trigger an automatic move back; that is the existing
 * manual "Cut over now" action only.
 */
export async function runFailoverForTenant(
  tenant: FailoverTenant,
  sites: FailoverSite[],
  actorId: string,
  deps: FailoverDeps
): Promise<FailoverAction> {
  const now = deps.now();

  const activeSite = tenant.activeGatewaySiteId ? sites.find((s) => s.id === tenant.activeGatewaySiteId) ?? null : null;
  const activeSiteHealthy = activeSite !== null && activeSite.enabled && activeSite.status === "UP" && isFresh(activeSite.lastHandshakeAt, now);

  const primary = selectPrimarySite(sites, now);
  if (!primary) return { type: "no_candidate" };

  if (activeSiteHealthy) {
    // The active site is fine — do nothing, even if `primary` names a
    // different, better-ranked site. This is the fail-back guard.
    return { type: "already_active", primaryId: tenant.activeGatewaySiteId as string };
  }

  if (!tenant.failoverEnabled) {
    return { type: "failover_disabled", primaryId: primary.id };
  }

  if (tenantInFailoverCooldown(sites, now)) {
    return { type: "cooldown", primaryId: primary.id };
  }

  if (await deps.hasActiveTrunkCall()) {
    return { type: "call_in_progress", primaryId: primary.id };
  }

  const cutoverInput: CutoverSiteInput = {
    id: primary.id,
    tunnelIp: primary.tunnelIp,
    gatewayLanIp: primary.gatewayLanIp,
  };

  const db = tenantDb(tenant.id);
  const result = await deps.cutoverToSite(db, cutoverInput, actorId);

  if (!result.ok) {
    await deps.recordFailedFailover({ tenantId: tenant.id, actorId, toSiteId: primary.id, error: result.error });
    return { type: "cutover_failed", primaryId: primary.id, error: result.error };
  }

  await deps.recordSuccessfulFailover({
    tenantId: tenant.id,
    actorId,
    fromSiteId: tenant.activeGatewaySiteId,
    toSiteId: primary.id,
    verified: result.provision?.verified,
    now,
  });
  await deps.sendFailoverAlert({ tenantId: tenant.id, toSiteId: primary.id, verified: result.provision?.verified });

  return { type: "cutover_succeeded", primaryId: primary.id, fromSiteId: tenant.activeGatewaySiteId };
}

// --- Real dependency implementations (production wiring) ------------------

/** Checks AMI for any channel currently live on the Dinstar trunk
 * endpoint, same CoreShowChannels + `PJSIP/dinstar-trunk-` prefix check
 * `src/app/api/calls/conference/route.ts` already uses to detect a call
 * already on the trunk. Fails CLOSED on any AMI error (treats it as "a
 * call might be in progress") — a supervisor that can't see the trunk's
 * state has no business re-pointing it. */
async function checkActiveCallOnTrunk(): Promise<boolean> {
  try {
    const ami = getAmiClient();
    await ami.connect();
    const { events } = await ami.sendAndCollect({ Action: "CoreShowChannels" }, "CoreShowChannelsComplete");
    return events.some((e) => e.Event === "CoreShowChannel" && typeof e.Channel === "string" && e.Channel.startsWith("PJSIP/dinstar-trunk-"));
  } catch {
    return true;
  }
}

async function recordSuccessfulFailover(input: {
  tenantId: string;
  actorId: string;
  fromSiteId: string | null;
  toSiteId: string;
  verified: boolean | undefined;
  now: Date;
}): Promise<void> {
  await unsafeGlobalDb.tenant.update({
    where: { id: input.tenantId },
    data: { activeGatewaySiteId: input.toSiteId },
  });
  await unsafeGlobalDb.gatewaySite.update({
    where: { id: input.toSiteId },
    data: { lastFailoverAt: input.now },
  });
  // AuditLog is tenant-scoped (TENANT_SCOPED_MODELS) — write it through
  // tenantDb the same way every other automated AuditLog row in this
  // module family does (see cutoverToSite's own audit write).
  await tenantDb(input.tenantId).auditLog.create({
    data: {
      action: "connectivity.auto_failover",
      actorId: input.actorId,
      targetId: input.toSiteId,
      metadata: {
        fromSiteId: input.fromSiteId,
        toSiteId: input.toSiteId,
        tenantId: input.tenantId,
        verified: input.verified ?? null,
      },
    } as unknown as Prisma.AuditLogUncheckedCreateInput,
  });
}

async function recordFailedFailover(input: { tenantId: string; actorId: string; toSiteId: string; error?: string }): Promise<void> {
  await tenantDb(input.tenantId).auditLog.create({
    data: {
      action: "connectivity.auto_failover_failed",
      actorId: input.actorId,
      targetId: input.toSiteId,
      metadata: { tenantId: input.tenantId, toSiteId: input.toSiteId, error: input.error ?? null },
    } as unknown as Prisma.AuditLogUncheckedCreateInput,
  });
  // Deliberately no retry here — the next cron tick re-evaluates from
  // scratch (plan §3.2 point 3e / this task's step 3e).
}

async function sendFailoverAlert(input: { tenantId: string; toSiteId: string; verified: boolean | undefined }): Promise<void> {
  const alertEmail = await getSetting("GATEWAY_ALERT_EMAIL", input.tenantId);
  if (!alertEmail) return;
  const site = await unsafeGlobalDb.gatewaySite.findUnique({ where: { id: input.toSiteId }, select: { name: true } });
  try {
    await sendGatewayAlertEmail(alertEmail, {
      type: "vpn.tunnel_unreachable",
      message: `Automatic failover moved the live SIP trunk to site "${site?.name ?? input.toSiteId}"${
        input.verified === false ? " (WARNING: PJSIP re-provision could not be verified — check the trunk manually)" : ""
      }.`,
      port: null,
    });
  } catch {
    // Best-effort — a failed alert email must never itself fail the
    // failover it's reporting on; the AuditLog row is the durable record
    // regardless of whether the email sends.
  }
}

const REAL_DEPS: FailoverDeps = {
  cutoverToSite,
  hasActiveTrunkCall: checkActiveCallOnTrunk,
  recordSuccessfulFailover,
  recordFailedFailover,
  sendFailoverAlert,
  now: () => new Date(),
};

/**
 * Production entry point — reads the tenant and its enabled gateway
 * sites fresh from the database (post connectivity-check writes) and
 * runs the supervisor against them with real dependencies. This is the
 * one function `connectivity-check/route.ts` calls, once per tenant that
 * has gateway sites, after its per-site status-write loop finishes.
 */
export async function checkAndFailoverTenant(tenantId: string, actorId: string): Promise<FailoverAction> {
  const tenant = await unsafeGlobalDb.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, activeGatewaySiteId: true, failoverEnabled: true },
  });
  if (!tenant) return { type: "no_candidate" };

  const sites = await unsafeGlobalDb.gatewaySite.findMany({
    where: { tenantId, enabled: true },
    orderBy: [{ priority: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      priority: true,
      enabled: true,
      status: true,
      lastHandshakeAt: true,
      lastFailoverAt: true,
      tunnelIp: true,
      gatewayLanIp: true,
      createdAt: true,
    },
  });

  return runFailoverForTenant(tenant, sites, actorId, REAL_DEPS);
}
