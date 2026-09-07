import { describe, it, expect } from "vitest";
import { PLAN_CATALOG, findPlan, isValidPlanChange } from "./plan-catalog";

describe("PLAN_CATALOG", () => {
  it("includes trial, standard and pro", () => {
    const ids = PLAN_CATALOG.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(["trial", "standard", "pro"]));
  });

  it("prices standard at the one figure this product has ever quoted", () => {
    expect(findPlan("standard")?.monthlyPriceUsd).toBe(500);
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
