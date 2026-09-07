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

export interface PlanDefinition {
  id: string;
  label: string;
  seatCeiling: number;
  monthlyPriceUsd: number;
}

export const PLAN_CATALOG: readonly PlanDefinition[] = [
  { id: "trial", label: "Trial", seatCeiling: 5, monthlyPriceUsd: 0 },
  // The one plan actually seeded/used in this repo (Tenant.plan's schema
  // default, and every reference in seed scripts / tests). Price matches the
  // number mrr.ts's now-removed PLAN_PRICES.standard used to hardcode.
  { id: "standard", label: "Standard", seatCeiling: 50, monthlyPriceUsd: 500 },
  { id: "pro", label: "Pro", seatCeiling: 200, monthlyPriceUsd: 1200 },
] as const;

export function findPlan(id: string): PlanDefinition | undefined {
  return PLAN_CATALOG.find((p) => p.id === id);
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
