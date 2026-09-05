// MRR arithmetic for the overview page.
//
// IMPORTANT FRAMING: this is BOOKKEEPING DISPLAY, not revenue data. There is
// no payment gateway connected (plan §5: manual invoicing is Phase 1; Paddle
// is Phase 2 and gated on an unresolved UAE-seller question). Nothing here
// has been reconciled against money that actually arrived — it is
// plan x seats, summed, for tenants we believe are paying.
//
// Every returned figure therefore carries `bookkeepingOnly: true`, and the UI
// renders a caption saying so. A number on an owner dashboard that looks like
// MRR will be treated as MRR; if it is really an estimate, it has to say so
// on the same screen, not in a doc nobody opens.

export interface MrrTenantView {
  id: string;
  slug: string;
  plan: string;
  seats: number;
  billingStatus: "TRIAL" | "ACTIVE" | "PAST_DUE" | "SUSPENDED";
  status: "TRIAL" | "ACTIVE" | "SUSPENDED" | "OFFBOARDED";
}

/** Per-seat monthly list price in AED. The public website advertises a single
 * AED 500/month standard plan, which is the only price this product has ever
 * actually quoted — the others are placeholders for plans that do not exist
 * yet and are priced here only so an unknown plan string cannot silently
 * contribute zero without being noticed (see `unpricedPlans` below). */
export const PLAN_PRICES: Record<string, number> = {
  standard: 500,
};

export interface MrrBreakdown {
  /** Sum over counted tenants of price(plan) x seats, in AED. */
  totalAed: number;
  byPlan: Array<{ plan: string; tenants: number; seats: number; aed: number }>;
  countedTenantIds: string[];
  /** Tenants deliberately excluded, with the reason, so the overview can
   * explain a total that looks lower than the tenant count implies. */
  excluded: Array<{ id: string; slug: string; reason: string }>;
  /** Plan strings with no entry in PLAN_PRICES. These contribute 0 and are
   * surfaced loudly rather than silently swallowed — a typo'd plan name
   * would otherwise just quietly shrink revenue. */
  unpricedPlans: string[];
  /** Always true. See this file's header. */
  bookkeepingOnly: true;
}

/**
 * Computes displayed MRR from plan x seats.
 *
 * Excludes OFFBOARDED tenants (the relationship ended) and TRIAL tenants
 * (nobody has agreed to pay yet). Deliberately INCLUDES PAST_DUE and
 * SUSPENDED tenants: they are contracted revenue we are chasing, and dropping
 * them the moment an invoice slips would make the headline number lurch
 * around for reasons that have nothing to do with the book of business.
 */
export function computeMrr(tenants: readonly MrrTenantView[]): MrrBreakdown {
  const excluded: MrrBreakdown["excluded"] = [];
  const counted: MrrTenantView[] = [];

  for (const t of tenants) {
    if (t.status === "OFFBOARDED") {
      excluded.push({ id: t.id, slug: t.slug, reason: "Offboarded" });
      continue;
    }
    if (t.billingStatus === "TRIAL" || t.status === "TRIAL") {
      excluded.push({ id: t.id, slug: t.slug, reason: "On trial — not yet billable" });
      continue;
    }
    counted.push(t);
  }

  const groups = new Map<string, { tenants: number; seats: number; aed: number }>();
  const unpriced = new Set<string>();

  for (const t of counted) {
    const price = PLAN_PRICES[t.plan];
    if (price === undefined) unpriced.add(t.plan);
    const seats = Number.isFinite(t.seats) && t.seats > 0 ? Math.floor(t.seats) : 0;
    const aed = (price ?? 0) * seats;

    const existing = groups.get(t.plan) ?? { tenants: 0, seats: 0, aed: 0 };
    groups.set(t.plan, {
      tenants: existing.tenants + 1,
      seats: existing.seats + seats,
      aed: existing.aed + aed,
    });
  }

  const byPlan = [...groups.entries()]
    .map(([plan, v]) => ({ plan, ...v }))
    .sort((a, b) => b.aed - a.aed || a.plan.localeCompare(b.plan));

  return {
    totalAed: byPlan.reduce((sum, g) => sum + g.aed, 0),
    byPlan,
    countedTenantIds: counted.map((t) => t.id),
    excluded,
    unpricedPlans: [...unpriced].sort(),
    bookkeepingOnly: true,
  };
}

export interface SeatSummary {
  /** Sum of Tenant.seats — what we have sold. */
  sold: number;
  /** Count of actual Extension rows — what has been handed out. */
  provisioned: number;
  /** Positive when tenants are using fewer seats than they bought. */
  unused: number;
  /** Tenants provisioned OVER their allocation — a billing conversation, and
   * the reason this is not just two numbers side by side. */
  overAllocated: Array<{ slug: string; sold: number; provisioned: number }>;
}

export function summariseSeats(
  rows: readonly { slug: string; seats: number; provisionedCount: number }[]
): SeatSummary {
  let sold = 0;
  let provisioned = 0;
  const overAllocated: SeatSummary["overAllocated"] = [];

  for (const r of rows) {
    const s = Number.isFinite(r.seats) && r.seats > 0 ? Math.floor(r.seats) : 0;
    sold += s;
    provisioned += r.provisionedCount;
    if (r.provisionedCount > s) {
      overAllocated.push({ slug: r.slug, sold: s, provisioned: r.provisionedCount });
    }
  }

  return { sold, provisioned, unused: Math.max(0, sold - provisioned), overAllocated };
}
