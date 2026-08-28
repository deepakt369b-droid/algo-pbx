import { describe, expect, it } from "vitest";
import { buildContactDisplayMap, resolveContactDisplayName } from "./contact-display";

describe("buildContactDisplayMap", () => {
  it("keys the map by numberE164", () => {
    const map = buildContactDisplayMap([
      { numberE164: "+971501234567", displayName: "Jane" },
      { numberE164: "+14155552671", displayName: null },
    ]);
    expect(map.get("+971501234567")).toBe("Jane");
    expect(map.get("+14155552671")).toBeNull();
    expect(map.has("+15551234")).toBe(false);
  });
});

describe("resolveContactDisplayName", () => {
  it("returns the Contact's displayName for a matching, normalizable number", () => {
    const map = buildContactDisplayMap([{ numberE164: "+971501234567", displayName: "Jane" }]);
    expect(resolveContactDisplayName("050 123 4567", map)).toBe("Jane");
    expect(resolveContactDisplayName("+971501234567", map)).toBe("Jane");
  });

  it("falls back to the normalized E.164 form when a Contact exists with no displayName", () => {
    const map = buildContactDisplayMap([{ numberE164: "+971501234567", displayName: null }]);
    expect(resolveContactDisplayName("050 123 4567", map)).toBe("+971501234567");
  });

  it("falls back to the raw number when there is no matching Contact", () => {
    const map = buildContactDisplayMap([]);
    expect(resolveContactDisplayName("+971509999999", map)).toBe("+971509999999");
  });

  it("falls back to the raw number when it can't be parsed as a phone number at all", () => {
    const map = buildContactDisplayMap([]);
    expect(resolveContactDisplayName("unknown", map)).toBe("unknown");
    expect(resolveContactDisplayName("1001", map)).toBe("1001");
  });
});
