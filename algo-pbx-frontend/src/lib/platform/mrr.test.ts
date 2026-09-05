import { describe, it, expect } from "vitest";
import { computeMrr, summariseSeats, PLAN_PRICES, type MrrTenantView } from "./mrr";

function t(overrides: Partial<MrrTenantView> = {}): MrrTenantView {
  return {
    id: "t1",
    slug: "acme",
    plan: "standard",
    seats: 5,
    billingStatus: "ACTIVE",
    status: "ACTIVE",
    ...overrides,
  };
}

describe("computeMrr", () => {
  it("multiplies plan price by seats", () => {
    const r = computeMrr([t({ seats: 5 })]);
    expect(r.totalAed).toBe(5 * PLAN_PRICES.standard);
    expect(r.totalAed).toBe(2500);
  });

  it("sums across tenants and groups by plan", () => {
    const r = computeMrr([
      t({ id: "a", slug: "a", seats: 5 }),
      t({ id: "b", slug: "b", seats: 3 }),
    ]);
    expect(r.totalAed).toBe(4000);
    expect(r.byPlan).toEqual([{ plan: "standard", tenants: 2, seats: 8, aed: 4000 }]);
    expect(r.countedTenantIds).toEqual(["a", "b"]);
  });

  it("always flags itself as bookkeeping-only", () => {
    expect(computeMrr([]).bookkeepingOnly).toBe(true);
    expect(computeMrr([t()]).bookkeepingOnly).toBe(true);
  });

  it("returns a zero total for no tenants without throwing", () => {
    const r = computeMrr([]);
    expect(r.totalAed).toBe(0);
    expect(r.byPlan).toEqual([]);
  });
});

describe("computeMrr — exclusions", () => {
  it("excludes offboarded tenants with a reason", () => {
    const r = computeMrr([t({ status: "OFFBOARDED" })]);
    expect(r.totalAed).toBe(0);
    expect(r.excluded).toEqual([{ id: "t1", slug: "acme", reason: "Offboarded" }]);
  });

  it("excludes trials — nobody has agreed to pay yet", () => {
    const r = computeMrr([t({ billingStatus: "TRIAL" })]);
    expect(r.totalAed).toBe(0);
    expect(r.excluded[0].reason).toMatch(/trial/i);
  });

  // Deliberate: a slipped invoice should not make the headline number lurch.
  it.each(["PAST_DUE", "SUSPENDED"] as const)("still counts %s tenants as contracted revenue", (billingStatus) => {
    const r = computeMrr([t({ billingStatus })]);
    expect(r.totalAed).toBe(2500);
    expect(r.excluded).toEqual([]);
  });
});

describe("computeMrr — unpriced plans are surfaced, not swallowed", () => {
  it("reports an unknown plan instead of silently contributing zero", () => {
    const r = computeMrr([t({ plan: "enterprise" })]);
    expect(r.totalAed).toBe(0);
    expect(r.unpricedPlans).toEqual(["enterprise"]);
    // Still counted as a tenant on that plan, so the row is visibly there
    // with an AED 0 that an operator will question.
    expect(r.byPlan).toEqual([{ plan: "enterprise", tenants: 1, seats: 5, aed: 0 }]);
  });

  it("deduplicates and sorts unpriced plan names", () => {
    const r = computeMrr([
      t({ id: "a", plan: "zeta" }),
      t({ id: "b", plan: "alpha" }),
      t({ id: "c", plan: "zeta" }),
    ]);
    expect(r.unpricedPlans).toEqual(["alpha", "zeta"]);
  });

  it("has no unpriced plans for the standard plan", () => {
    expect(computeMrr([t()]).unpricedPlans).toEqual([]);
  });
});

describe("computeMrr — defensive arithmetic", () => {
  it.each([0, -3, NaN])("treats a seats value of %s as zero rather than producing NaN", (seats) => {
    const r = computeMrr([t({ seats })]);
    expect(r.totalAed).toBe(0);
    expect(Number.isNaN(r.totalAed)).toBe(false);
  });

  it("floors fractional seats", () => {
    expect(computeMrr([t({ seats: 5.9 })]).totalAed).toBe(2500);
  });
});

describe("summariseSeats", () => {
  it("totals sold vs provisioned and the unused gap", () => {
    const s = summariseSeats([
      { slug: "a", seats: 10, provisionedCount: 7 },
      { slug: "b", seats: 5, provisionedCount: 2 },
    ]);
    expect(s).toMatchObject({ sold: 15, provisioned: 9, unused: 6 });
    expect(s.overAllocated).toEqual([]);
  });

  it("flags tenants provisioned beyond their allocation", () => {
    const s = summariseSeats([{ slug: "a", seats: 5, provisionedCount: 8 }]);
    expect(s.overAllocated).toEqual([{ slug: "a", sold: 5, provisioned: 8 }]);
  });

  it("never reports negative unused seats when overall over-provisioned", () => {
    const s = summariseSeats([{ slug: "a", seats: 2, provisionedCount: 9 }]);
    expect(s.unused).toBe(0);
  });

  it("returns zeros for an empty platform", () => {
    expect(summariseSeats([])).toEqual({ sold: 0, provisioned: 0, unused: 0, overAllocated: [] });
  });
});
