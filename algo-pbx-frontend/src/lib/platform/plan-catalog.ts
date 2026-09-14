// Plan catalogue — replaces the free-text `plan` field's previously
// unenforced value with a fixed, typed set of tiers.
//
// `Tenant.plan` STAYS a plain `String` column (plan §5: "Tenant.plan stays a
// String column" — this is a code-side constant, not a schema change, and
// this file's whole existence is why W1 does not depend on the G0 migration
// node). Validation lives here instead: a plan id that isn't in this
// catalogue is rejected at the API layer (see the `change_plan` action of
// `PATCH /api/platform/tenants/[id]/billing`), and `findPlan()` is the single
// place `src/lib/platform/mrr.ts` now goes for a per-seat price.
//
// Pricing is expressed in USD (`monthlyPriceUsd`) per the task spec, even
// though the only price this product has ever actually quoted publicly is
// AED 500/month for "standard" (see mrr.ts's prior `PLAN_PRICES`). The
// numeric value below is kept identical (500) so that a plan-catalog-backed
// `computeMrr()` still returns the same figures existing tests and the
// overview page assert — but note the label now reads "USD" per this task's
// explicit field name while the business has only ever quoted AED. This is a
// currency-label inconsistency inherited from the task spec, not a business
// decision made here; flagged for whoever wires an actual payment processor
// in Phase 2 (see billing-tab.tsx's "Payment automation: Phase 2" card).
//
// Seat ceilings are new — nothing enforced a per-plan seat cap before this
// file. Sized generously (nobody has ever bought more than a handful of
// seats on this deployment) rather than derived from any real quota
// decision, since none has been made yet.

/** Named per-plan feature flags. Kept as a small closed set (not free-text)
 * so `planHasFeature()` can be exhaustive-checked; a plan that doesn't offer
 * any extras simply omits the key it doesn't have from `features`. */
export interface PlanFeatures {
  aiAgents?: boolean;
}

export interface PlanDefinition {
  id: string;
  label: string;
  seatCeiling: number;
  monthlyPriceUsd: number;
  /** Ordering position, low to high, for deciding whether a plan change is an
   * upgrade or a downgrade (`comparePlans`). Price order and seat-ceiling
   * order happen to agree across the whole catalogue, so this rank is
   * unambiguous — it is stated explicitly rather than derived from either,
   * so that adding a plan whose price and capacity disagree forces whoever
   * adds it to make the ordering decision here, consciously, instead of
   * silently inheriting whichever field the code happened to sort by. */
  rank: number;
  /** Defaults to `{}` (no extra features) for plans that don't set it. */
  features?: PlanFeatures;
}

export const PLAN_CATALOG: readonly PlanDefinition[] = [
  { id: "trial", label: "Trial", seatCeiling: 5, monthlyPriceUsd: 0, rank: 0 },
  // The one plan actually seeded/used in this repo (Tenant.plan's schema
  // default, and every reference in seed scripts / tests). Price matches the
  // number mrr.ts's now-removed PLAN_PRICES.standard used to hardcode.
  { id: "standard", label: "Standard", seatCeiling: 50, monthlyPriceUsd: 500, rank: 1 },
  { id: "pro", label: "Pro", seatCeiling: 200, monthlyPriceUsd: 1200, rank: 3 },
  // Hybrid AI + Human plan (LLM.md decision, 2026-09-14): the only tier that
  // unlocks AI-kind extensions (AiAgent config, provider credentials, AI
  // call sessions — see .agents/hybrid-ai/contracts.md). Seat ceiling follows
  // the same "generously sized, not a real quota decision" philosophy as
  // standard/pro above, pitched between the two since this is a premium add-on
  // rather than a raw-capacity tier.
  //
  // Ranked BELOW pro (2 vs 3) because it costs less and carries fewer seats —
  // which makes premium -> pro an "upgrade" that nonetheless LOSES aiAgents,
  // since pro is a raw-capacity tier with no AI. That case is deliberately
  // allowed rather than reordered around: `describePlanChange` reports
  // `featuresLost` independently of `direction`, so the feature loss is
  // surfaced and acted on whichever way the rank happens to point.
  { id: "premium", label: "Premium", seatCeiling: 100, monthlyPriceUsd: 800, rank: 2, features: { aiAgents: true } },
] as const;

export function findPlan(id: string): PlanDefinition | undefined {
  return PLAN_CATALOG.find((p) => p.id === id);
}

/** Whether the given plan id grants a named feature. An unknown plan id
 * behaves the same as a known plan with no `features` entry: `false`, never
 * a throw — callers gate optional functionality with this, they don't use it
 * to validate the plan id itself (that's `findPlan`/`isValidPlanChange`). */
export function planHasFeature(plan: string, feature: keyof PlanFeatures): boolean {
  return Boolean(findPlan(plan)?.features?.[feature]);
}

/** Whether `planId`/`seats` is a change the billing route may accept:
 * the plan id must exist in the catalogue, and the requested seat count must
 * not exceed that plan's ceiling. Pure and unit-tested without a database —
 * the route itself only has to call this and return 400 on `false`. */
export function isValidPlanChange(planId: string, seats: number): boolean {
  const plan = findPlan(planId);
  if (!plan) return false;
  if (!Number.isFinite(seats) || seats <= 0) return false;
  return seats <= plan.seatCeiling;
}

export type PlanChangeDirection = "upgrade" | "downgrade" | "same";

/** Upgrade/downgrade purely from each plan's `rank` — see PlanDefinition.rank
 * for why rank, not price or seatCeiling directly, is the source of truth.
 * `null` for either id (not in the catalogue) is reported as "same": callers
 * that need to reject an unknown plan id do so via `isValidPlanChange`
 * first, so by the time direction matters both ids are already known-valid. */
export function comparePlans(fromPlanId: string, toPlanId: string): PlanChangeDirection {
  const from = findPlan(fromPlanId);
  const to = findPlan(toPlanId);
  if (!from || !to || from.rank === to.rank) return "same";
  return to.rank > from.rank ? "upgrade" : "downgrade";
}

export interface PlanChangeDescription {
  direction: PlanChangeDirection;
  /** `toPlan.monthlyPriceUsd - fromPlan.monthlyPriceUsd`. */
  priceDeltaUsd: number;
  /** `newSeats - fromPlan.seats` isn't knowable here (this module doesn't
   * see the tenant's CURRENT seat count) — this is the seat-ceiling delta
   * between the two plans, i.e. how much MORE capacity the new plan allows
   * for, not how many more seats were actually requested. */
  seatCeilingDelta: number;
  /** Feature keys the destination plan grants that the source didn't. */
  featuresGained: (keyof PlanFeatures)[];
  /** Feature keys the source plan granted that the destination doesn't —
   * this is what drives locking AiAgent rows in the billing route. */
  featuresLost: (keyof PlanFeatures)[];
  /** Non-empty means the change must be REFUSED, not just warned about — the
   * billing route returns 409 with `blockers[0]` (there is only ever one
   * check today, seats-below-usage, but this stays a list so a future
   * blocker doesn't need a shape change). */
  blockers: string[];
  /** How many of the tenant's AiAgent rows will be locked (enabled: false)
   * as a result of `featuresLost` including "aiAgents". 0 when the change
   * doesn't lose the feature, or the tenant has no agents. */
  aiAgentsToLock: number;
}

const ALL_FEATURE_KEYS: (keyof PlanFeatures)[] = ["aiAgents"];

function featureKeysOf(plan: PlanDefinition): (keyof PlanFeatures)[] {
  return ALL_FEATURE_KEYS.filter((key) => plan.features?.[key]);
}

/** The single place that decides everything about a prospective plan change
 * besides "is the plan id itself valid" (still `isValidPlanChange`, called
 * separately since it doesn't need a tenant's current usage). Pure and DB-
 * free: the route resolves `extensionsInUse`/`aiAgentCount` from the DB and
 * hands them in, so this function — the part with all the actual decision
 * logic — is fully unit-testable without mocking Prisma. Returns a
 * best-effort description even for an invalid target plan/seat count; the
 * route still calls `isValidPlanChange` first and 400s before this ever
 * runs, so `fromPlanId`/`toPlanId` are assumed already known-valid here. */
export function describePlanChange(input: {
  fromPlanId: string;
  toPlanId: string;
  newSeats: number;
  extensionsInUse: number;
  aiAgentCount: number;
}): PlanChangeDescription {
  const fromPlan = findPlan(input.fromPlanId);
  const toPlan = findPlan(input.toPlanId);
  const direction = comparePlans(input.fromPlanId, input.toPlanId);

  const fromFeatures = fromPlan ? featureKeysOf(fromPlan) : [];
  const toFeatures = toPlan ? featureKeysOf(toPlan) : [];
  const featuresGained = toFeatures.filter((f) => !fromFeatures.includes(f));
  const featuresLost = fromFeatures.filter((f) => !toFeatures.includes(f));

  const blockers: string[] = [];
  if (input.newSeats < input.extensionsInUse) {
    blockers.push(
      `${input.extensionsInUse} extension${input.extensionsInUse === 1 ? "" : "s"} in use, ` +
        `${input.newSeats} seat${input.newSeats === 1 ? "" : "s"} requested — ` +
        `remove ${input.extensionsInUse - input.newSeats} extension${input.extensionsInUse - input.newSeats === 1 ? "" : "s"} first, ` +
        `or choose a plan/seat count that covers what's already in use.`
    );
  }

  const aiAgentsToLock = featuresLost.includes("aiAgents") ? input.aiAgentCount : 0;

  return {
    direction,
    priceDeltaUsd: (toPlan?.monthlyPriceUsd ?? 0) - (fromPlan?.monthlyPriceUsd ?? 0),
    seatCeilingDelta: (toPlan?.seatCeiling ?? 0) - (fromPlan?.seatCeiling ?? 0),
    featuresGained,
    featuresLost,
    blockers,
    aiAgentsToLock,
  };
}
