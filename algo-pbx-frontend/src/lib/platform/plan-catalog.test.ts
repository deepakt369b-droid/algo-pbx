import { describe, it, expect } from "vitest";
import { PLAN_CATALOG, findPlan, isValidPlanChange, planHasFeature, comparePlans, describePlanChange } from "./plan-catalog";

describe("PLAN_CATALOG", () => {
  it("includes trial, standard, pro and premium", () => {
    const ids = PLAN_CATALOG.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["trial", "standard", "pro", "premium"]));
  });

  it("prices standard at the one figure this product has ever quoted", () => {
    expect(findPlan("standard")?.monthlyPriceUsd).toBe(500);
  });

  it("prices premium at AED 800/mo", () => {
    expect(findPlan("premium")?.monthlyPriceUsd).toBe(800);
  });

  it("gives premium a seat ceiling in line with the standard/pro philosophy", () => {
    const premium = findPlan("premium")!;
    expect(premium.seatCeiling).toBeGreaterThan(findPlan("standard")!.seatCeiling);
    expect(premium.seatCeiling).toBeLessThanOrEqual(findPlan("pro")!.seatCeiling);
  });
});

describe("findPlan", () => {
  it("finds a known plan", () => {
    expect(findPlan("standard")?.label).toBe("Standard");
  });

  it("returns undefined for an unknown plan id", () => {
    expect(findPlan("enterprise")).toBeUndefined();
  });
});

describe("isValidPlanChange", () => {
  it("accepts seats within the plan's ceiling", () => {
    expect(isValidPlanChange("standard", 10)).toBe(true);
  });

  it("rejects an unknown plan id", () => {
    expect(isValidPlanChange("enterprise", 10)).toBe(false);
  });

  it("rejects seats above the plan's ceiling", () => {
    const plan = findPlan("trial")!;
    expect(isValidPlanChange("trial", plan.seatCeiling + 1)).toBe(false);
  });

  it("accepts seats exactly at the ceiling", () => {
    const plan = findPlan("standard")!;
    expect(isValidPlanChange("standard", plan.seatCeiling)).toBe(true);
  });

  it("rejects zero or negative seats", () => {
    expect(isValidPlanChange("standard", 0)).toBe(false);
    expect(isValidPlanChange("standard", -1)).toBe(false);
  });
});

describe("planHasFeature", () => {
  it("only premium grants aiAgents", () => {
    expect(planHasFeature("premium", "aiAgents")).toBe(true);
    expect(planHasFeature("standard", "aiAgents")).toBe(false);
    expect(planHasFeature("pro", "aiAgents")).toBe(false);
    expect(planHasFeature("trial", "aiAgents")).toBe(false);
  });

  it("returns false, not a throw, for an unknown plan id", () => {
    expect(planHasFeature("enterprise", "aiAgents")).toBe(false);
  });
});

describe("PLAN_CATALOG rank", () => {
  it("is monotonic with price and seat ceiling across the whole catalogue", () => {
    const byRank = [...PLAN_CATALOG].sort((a, b) => a.rank - b.rank);
    for (let i = 1; i < byRank.length; i++) {
      expect(byRank[i].monthlyPriceUsd).toBeGreaterThan(byRank[i - 1].monthlyPriceUsd);
      expect(byRank[i].seatCeiling).toBeGreaterThan(byRank[i - 1].seatCeiling);
    }
  });

  it("every plan has a unique rank", () => {
    const ranks = PLAN_CATALOG.map((p) => p.rank);
    expect(new Set(ranks).size).toBe(ranks.length);
  });
});

describe("comparePlans", () => {
  it("reports an upgrade moving to a higher-rank plan", () => {
    expect(comparePlans("standard", "premium")).toBe("upgrade");
    expect(comparePlans("trial", "pro")).toBe("upgrade");
  });

  it("reports a downgrade moving to a lower-rank plan", () => {
    expect(comparePlans("pro", "standard")).toBe("downgrade");
  });

  it("reports 'same' for the identical plan", () => {
    expect(comparePlans("standard", "standard")).toBe("same");
  });

  it("premium -> pro is labelled an upgrade despite losing aiAgents", () => {
    // The deliberately-accepted wrinkle: pro outranks premium on price/seats,
    // even though only premium carries the AI feature. describePlanChange
    // (tested below) is what actually catches and reports the feature loss —
    // comparePlans only ever answers the rank question.
    expect(comparePlans("premium", "pro")).toBe("upgrade");
  });

  it("reports 'same' for an unknown plan id rather than throwing", () => {
    expect(comparePlans("standard", "enterprise")).toBe("same");
    expect(comparePlans("enterprise", "standard")).toBe("same");
  });
});

describe("describePlanChange", () => {
  it("blocks a downgrade whose new seat count is below extensions in use", () => {
    const result = describePlanChange({
      fromPlanId: "pro",
      toPlanId: "standard",
      newSeats: 4,
      extensionsInUse: 6,
      aiAgentCount: 0,
    });
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0]).toMatch(/6 extensions in use/);
    expect(result.blockers[0]).toMatch(/4 seats requested/);
  });

  it("does not block when the new seat count covers extensions in use exactly", () => {
    const result = describePlanChange({
      fromPlanId: "pro",
      toPlanId: "standard",
      newSeats: 6,
      extensionsInUse: 6,
      aiAgentCount: 0,
    });
    expect(result.blockers).toHaveLength(0);
  });

  it("reports featuresLost and the exact AI agent count to lock when leaving premium", () => {
    const result = describePlanChange({
      fromPlanId: "premium",
      toPlanId: "standard",
      newSeats: 10,
      extensionsInUse: 3,
      aiAgentCount: 5,
    });
    expect(result.direction).toBe("downgrade");
    expect(result.featuresLost).toEqual(["aiAgents"]);
    expect(result.featuresGained).toEqual([]);
    expect(result.aiAgentsToLock).toBe(5);
    expect(result.blockers).toHaveLength(0);
  });

  it("locks zero agents when the tenant has none, even while losing the feature", () => {
    const result = describePlanChange({
      fromPlanId: "premium",
      toPlanId: "standard",
      newSeats: 10,
      extensionsInUse: 3,
      aiAgentCount: 0,
    });
    expect(result.featuresLost).toEqual(["aiAgents"]);
    expect(result.aiAgentsToLock).toBe(0);
  });

  it("reports featuresGained when moving onto premium", () => {
    const result = describePlanChange({
      fromPlanId: "standard",
      toPlanId: "premium",
      newSeats: 20,
      extensionsInUse: 3,
      aiAgentCount: 0,
    });
    expect(result.direction).toBe("upgrade");
    expect(result.featuresGained).toEqual(["aiAgents"]);
    expect(result.featuresLost).toEqual([]);
  });

  it("premium -> pro: upgrade direction, but still reports the AI loss and lock count", () => {
    const result = describePlanChange({
      fromPlanId: "premium",
      toPlanId: "pro",
      newSeats: 50,
      extensionsInUse: 10,
      aiAgentCount: 2,
    });
    expect(result.direction).toBe("upgrade");
    expect(result.featuresLost).toEqual(["aiAgents"]);
    expect(result.aiAgentsToLock).toBe(2);
    expect(result.priceDeltaUsd).toBe(400); // 1200 - 800
  });

  it("computes priceDeltaUsd and seatCeilingDelta correctly in both directions", () => {
    const up = describePlanChange({ fromPlanId: "standard", toPlanId: "pro", newSeats: 50, extensionsInUse: 0, aiAgentCount: 0 });
    expect(up.priceDeltaUsd).toBe(700); // 1200 - 500
    expect(up.seatCeilingDelta).toBe(150); // 200 - 50

    const down = describePlanChange({ fromPlanId: "pro", toPlanId: "standard", newSeats: 50, extensionsInUse: 0, aiAgentCount: 0 });
    expect(down.priceDeltaUsd).toBe(-700);
    expect(down.seatCeilingDelta).toBe(-150);
  });
});
