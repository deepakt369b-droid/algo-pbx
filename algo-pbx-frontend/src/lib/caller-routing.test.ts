import { describe, it, expect } from "vitest";
import { matchCallerRule } from "./caller-routing";

describe("matchCallerRule", () => {
  it("returns null when no rule matches", () => {
    expect(matchCallerRule("+971501234567", [{ pattern: "+9714*", action: "BLOCK" }])).toBeNull();
  });

  it("matches an exact pattern", () => {
    const rules = [{ pattern: "+971501234567", action: "PASS" as const }];
    expect(matchCallerRule("+971501234567", rules)).toEqual(rules[0]);
  });

  it("matches a prefix pattern ending in *", () => {
    const rules = [{ pattern: "+9715*", action: "BLOCK" as const }];
    expect(matchCallerRule("+971501234567", rules)).toEqual(rules[0]);
  });

  it("does not match a prefix that isn't a real prefix of the caller number", () => {
    const rules = [{ pattern: "+9714*", action: "BLOCK" as const }];
    expect(matchCallerRule("+971501234567", rules)).toBeNull();
  });

  it("prefers an exact match over any prefix match", () => {
    const exact = { pattern: "+971501234567", action: "PASS" as const };
    const prefix = { pattern: "+9715*", action: "BLOCK" as const };
    expect(matchCallerRule("+971501234567", [prefix, exact])).toEqual(exact);
    expect(matchCallerRule("+971501234567", [exact, prefix])).toEqual(exact);
  });

  it("prefers a longer (more specific) prefix over a shorter one", () => {
    const shortPrefix = { pattern: "+971*", action: "AI" as const };
    const longPrefix = { pattern: "+97150*", action: "PASS" as const };
    expect(matchCallerRule("+971501234567", [shortPrefix, longPrefix])).toEqual(longPrefix);
    expect(matchCallerRule("+971501234567", [longPrefix, shortPrefix])).toEqual(longPrefix);
  });

  it("is case-insensitive", () => {
    const rules = [{ pattern: "+9715*", action: "BLOCK" as const }];
    expect(matchCallerRule("+971501234567".toUpperCase(), rules)).toEqual(rules[0]);
  });

  it("returns null for an empty rule list", () => {
    expect(matchCallerRule("+971501234567", [])).toBeNull();
  });
});
