import type { Prisma } from "@prisma/client";
import type { TenantClient } from "@/lib/db-tenant";
import { getSetting, setSetting } from "@/lib/settings/service";
import { provisionDinstarConfig, type DinstarProvisionResult } from "@/lib/dinstar-provision";

// Wave 2a multi-tenant migration: cutoverToSite() takes a REQUIRED
// tenant-scoped `db: TenantClient` (src/lib/db-tenant.ts) instead of
// importing a module-level singleton — dependency injection per plan §2.
// Its caller (POST /api/admin/gateway-sites/[id]/cutover) already has one
// from requireAdminSession(). DINSTAR_LAN_IP is still read/written as a
// single platform-global AppSetting (getSetting/setSetting called with no
// tenantId) — deliberately unchanged: per the plan's §8 gap analysis this
// setting is meant to move onto GatewaySite.tunnelIp as a per-tenant field,
// but that's a later wave's job, not this one's; today there is exactly one
// real tenant in production, so the global setting still reflects the
// correct, single trunk destination (Requirement A parity).

// The cutover MECHANISM (OpenVPN/Headscale/connectivity task, Node G) — what
// a human-supervised G2 session invokes once a site's tunnel is confirmed up
// (see the plan's "G2 — HUMAN GATE, LIVE, SUPERVISED" checklist). This
// module does not itself decide WHEN to cut over; it does the cutover
// correctly once told to.
//
// DINSTAR_LAN_IP is the single AppSetting driving both the SIP trunk's
// [dinstar-aor]/[dinstar-identify] contact IP and the SMS provider's base
// URL (dinstar-sms-provider.ts re-reads the setting on every request, no
// separate step) — confirmed this session, see the plan's "Verified before
// planning" section. provisionDinstarConfig() (src/lib/dinstar-provision.ts)
// already renders the trunk config, hot-reloads PJSIP over AMI, and
// verifies via `pjsip show aor dinstar-aor` — reused here completely
// unmodified, not reimplemented.
//
// EXPLICITLY OUT OF SCOPE, stated here so it isn't assumed to be covered:
// this function does NOT re-point the gateway's own Diagnostic -> Syslog
// Remote Server setting on the Dinstar's own web UI. That's a separate
// manual step the G2 session performs directly on the gateway (Tools has no
// automation for it yet), verified independently by Node F's dual-homed
// syslog listener actually receiving events on the new path (G2 step 6).
// Do not read "cutover" here as "every consumer of the gateway's address is
// now handled" — only the two DINSTAR_LAN_IP consumers are.

export interface CutoverSiteInput {
  id: string;
  tunnelIp: string | null;
  gatewayLanIp: string;
}

export interface CutoverResult {
  ok: boolean;
  /** Why `ok` is false, when it is — e.g. "no tunnel IP assigned yet". Never
   * set alongside a successful settingUpdated+provision. */
  error?: string;
  settingUpdated: boolean;
  provision?: DinstarProvisionResult;
}

/** Point the live SIP trunk (and, transitively, the SMS provider) at a
 * site's OpenVPN tunnel IP, and record the change. Does NOT set
 * `GatewaySite.status` to UP — that would be claiming a live-traffic fact
 * this function hasn't actually verified; the connectivity poller (Node F)
 * determines status independently on its own next run. This function's job
 * is the config push, not the connectivity proof. */
export async function cutoverToSite(db: TenantClient, site: CutoverSiteInput, actorId: string): Promise<CutoverResult> {
  if (!site.tunnelIp) {
    return {
      ok: false,
      error: "This site has no tunnel IP assigned yet — generate and push its OpenVPN config first (the Add-site wizard), and confirm the tunnel is actually up, before cutting over the trunk to it.",
      settingUpdated: false,
    };
  }

  // DINSTAR_LAN_IP is not marked `secret` in the settings registry (it's an
  // IP address, not a credential) — safe to record its real previous value
  // on the audit row via the normal decrypt-on-read accessor, not just a
  // placeholder.
  const previousLanIp = (await getSetting("DINSTAR_LAN_IP")) ?? null;

  await setSetting("DINSTAR_LAN_IP", site.tunnelIp, actorId);

  const provision = await provisionDinstarConfig(site.tunnelIp);

  // Only claim this site is actually on the OpenVPN transport once
  // provisionDinstarConfig's own AMI read-back CONFIRMED the trunk picked up
  // the new IP (V1 security review caught this originally being set
  // unconditionally — a real "claiming a fact we didn't verify" bug, the
  // exact thing this whole feature's design has tried to avoid elsewhere).
  // Deliberately NOT auto-rolling-back DINSTAR_LAN_IP on failure either: a
  // naive rollback that isn't itself re-verified could leave Postgres's
  // setting and whatever Asterisk actually has loaded in a WORSE
  // disagreement than just leaving the setting at its new value and
  // surfacing the failure loudly (see the route's non-200 response) — a
  // human is present for G2 by design; let them decide the next step
  // instead of the code silently "fixing" a half-applied change.
  if (provision.verified) {
    await db.gatewaySite.update({
      where: { id: site.id },
      data: { transport: "OPENVPN" },
    });
  }

  // No `tenantId` in this literal — the `TenantClient` extension
  // force-injects it at runtime regardless of what's passed (see
  // crm/activity.ts's comment on the same pattern); the double-cast below
  // satisfies the compiler about that runtime guarantee.
  await db.auditLog.create({
    data: {
      action: "site.cutover",
      actorId,
      targetId: site.id,
      metadata: {
        siteId: site.id,
        previousLanIp,
        newTunnelIp: site.tunnelIp,
        provisionVerified: provision.verified,
        provisionError: provision.error ?? null,
        // The syslog-retarget caveat this function deliberately does not
        // handle — recorded on the audit row too, not just in code
        // comments, so the trail itself documents the gap.
        syslogRemoteServerRetargeted: false,
        syslogRemoteServerNote:
          "Not handled by this function — re-point the gateway's own Diagnostic -> Syslog Remote Server setting manually as a separate G2 step, then confirm via the dual-homed listener.",
      },
    } as unknown as Prisma.AuditLogUncheckedCreateInput,
  });

  return {
    ok: true,
    settingUpdated: true,
    provision,
  };
}
