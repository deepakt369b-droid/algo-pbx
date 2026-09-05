// The overview page's attention queue.
//
// Design rule this module enforces: EVERY item deep-links to the thing that
// fixes it. A dashboard that says "3 failed recording deliveries" and makes
// the operator go hunting is worse than one that says nothing — it creates an
// obligation without a path, and obligations without paths get ignored, which
// is how a queue of real problems becomes background noise.
//
// Pure over already-fetched inputs, so ordering, thresholds and hrefs are all
// unit-testable without a database.

export type AttentionSeverity = "critical" | "warning" | "info";

export interface AttentionItem {
  /** Stable within a render, so React keys and tests are not order-dependent. */
  id: string;
  severity: AttentionSeverity;
  title: string;
  detail: string;
  /** The page that fixes it. Never null — see this file's header. */
  href: string;
  /** Sorts within a severity band; lower is more urgent. */
  rank: number;
}

export interface AttentionInputs {
  tenants: Array<{
    id: string;
    slug: string;
    name: string;
    status: "TRIAL" | "ACTIVE" | "SUSPENDED" | "OFFBOARDED";
    paidUntil: Date | null;
    complianceComplete: boolean;
    complianceSummary: string;
    provisioningIncomplete: boolean;
    provisioningNextStepLabel: string | null;
  }>;
  gatewaySites: Array<{
    id: string;
    tenantId: string;
    tenantSlug: string;
    name: string;
    lastHandshakeAt: Date | null;
    status: "UNKNOWN" | "UP" | "DEGRADED" | "DOWN";
  }>;
  supportGrants: Array<{
    id: string;
    tenantId: string;
    tenantSlug: string;
    platformUserEmail: string;
    expiresAt: Date;
  }>;
  failedDeliveries: Array<{ tenantId: string; tenantSlug: string; count: number }>;
}

/** paidUntil inside this window raises an info item, before the ladder bites. */
export const PAID_UNTIL_WARNING_DAYS = 14;
/** A live grant expiring within this window is worth flagging — long enough to
 * wrap up an investigation, short enough not to nag all day. */
export const GRANT_EXPIRY_WARNING_HOURS = 2;

const MS_HOUR = 60 * 60 * 1000;
const MS_DAY = 24 * MS_HOUR;

const SEVERITY_ORDER: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 };

function tenantHref(id: string, tab?: string): string {
  return tab ? `/platform/tenants/${id}?tab=${tab}` : `/platform/tenants/${id}`;
}

export function buildAttentionQueue(inputs: AttentionInputs, now: Date = new Date()): AttentionItem[] {
  const items: AttentionItem[] = [];

  // --- Failed recording deliveries. Critical: these are customer data that
  // we accepted responsibility for and have not delivered.
  for (const d of inputs.failedDeliveries) {
    if (d.count <= 0) continue;
    items.push({
      id: `delivery:${d.tenantId}`,
      severity: "critical",
      title: `${d.count} failed recording deliver${d.count === 1 ? "y" : "ies"} — ${d.tenantSlug}`,
      detail: "Recordings have not reached this tenant's configured storage target.",
      href: tenantHref(d.tenantId, "gateway"),
      rank: 1000 - Math.min(d.count, 999),
    });
  }

  // --- Tunnels down. Critical: no tunnel means no gateway control path, and
  // for a live tenant it may mean no calls.
  for (const site of inputs.gatewaySites) {
    if (site.status === "DOWN") {
      items.push({
        id: `tunnel-down:${site.id}`,
        severity: "critical",
        title: `OpenVPN tunnel down — ${site.name}`,
        detail: `${site.tenantSlug}'s gateway is not connected.`,
        href: tenantHref(site.tenantId, "gateway"),
        rank: 10,
      });
    } else if (site.lastHandshakeAt === null) {
      // Never up at all — a provisioning gap rather than an outage, so it is
      // a warning, and it is exactly what blocks the provisioning pipeline.
      items.push({
        id: `tunnel-never:${site.id}`,
        severity: "warning",
        title: `Tunnel has never connected — ${site.name}`,
        detail: `${site.tenantSlug}'s gateway has no recorded handshake. Provisioning beyond cert issuance is blocked.`,
        href: tenantHref(site.tenantId, "gateway"),
        rank: 20,
      });
    }
  }

  // --- Expiring support grants. Warning: access is about to vanish mid-
  // investigation, and the operator can extend deliberately rather than being
  // surprised.
  for (const g of inputs.supportGrants) {
    const msLeft = g.expiresAt.getTime() - now.getTime();
    if (msLeft <= 0) continue;
    if (msLeft > GRANT_EXPIRY_WARNING_HOURS * MS_HOUR) continue;
    const minutes = Math.max(1, Math.round(msLeft / (60 * 1000)));
    items.push({
      id: `grant:${g.id}`,
      severity: "warning",
      title: `Support grant expires in ${minutes} min — ${g.tenantSlug}`,
      detail: `Held by ${g.platformUserEmail}.`,
      href: tenantHref(g.tenantId, "support"),
      rank: minutes,
    });
  }

  for (const t of inputs.tenants) {
    if (t.status === "OFFBOARDED") continue;

    // --- Pending provisioning. Warning: a half-provisioned tenant is a
    // customer who cannot fully use what they bought.
    if (t.provisioningIncomplete) {
      items.push({
        id: `provisioning:${t.id}`,
        severity: "warning",
        title: `Provisioning incomplete — ${t.slug}`,
        detail: t.provisioningNextStepLabel
          ? `Next step: ${t.provisioningNextStepLabel}.`
          : "The provisioning pipeline has not finished.",
        href: `/platform/provisioning?tenant=${t.id}`,
        rank: 30,
      });
    }

    // --- paidUntil approaching. Info: nothing is broken, but an invoice
    // wants sending before the ladder starts.
    if (t.paidUntil !== null && t.status !== "SUSPENDED") {
      const daysLeft = Math.floor((t.paidUntil.getTime() - now.getTime()) / MS_DAY);
      if (daysLeft >= 0 && daysLeft <= PAID_UNTIL_WARNING_DAYS) {
        items.push({
          id: `paid-until:${t.id}`,
          severity: "info",
          title: `Paid until expires in ${daysLeft} day${daysLeft === 1 ? "" : "s"} — ${t.slug}`,
          detail: "Invoice before the grace period starts. Calls are never affected by billing.",
          href: tenantHref(t.id, "billing"),
          rank: daysLeft,
        });
      }
    }

    // --- Compliance gaps. Info, deliberately: incomplete paperwork does not
    // block anything technical, but it must stay visible rather than
    // disappearing once the tenant is created.
    if (!t.complianceComplete) {
      items.push({
        id: `compliance:${t.id}`,
        severity: "info",
        title: `Compliance checklist incomplete — ${t.slug}`,
        detail: t.complianceSummary,
        href: tenantHref(t.id, "identity"),
        rank: 500,
      });
    }
  }

  return items.sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      a.rank - b.rank ||
      a.id.localeCompare(b.id)
  );
}

export function countBySeverity(items: AttentionItem[]): Record<AttentionSeverity, number> {
  return items.reduce(
    (acc, i) => ({ ...acc, [i.severity]: acc[i.severity] + 1 }),
    { critical: 0, warning: 0, info: 0 } as Record<AttentionSeverity, number>
  );
}
