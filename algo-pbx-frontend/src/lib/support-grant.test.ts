import { describe, expect, it } from "vitest";
import { isGrantLive, clampSupportGrantDuration } from "./support-grant";

describe("isGrantLive", () => {
  const NOW = new Date("2026-09-04T12:00:00Z");

  it("is live when not revoked and expiry is in the future", () => {
    expect(
      isGrantLive({ expiresAt: new Date("2026-09-04T12:05:00Z"), revokedAt: null }, NOW)
    ).toBe(true);
  });

  it("is not live once expiresAt has passed", () => {
    expect(
      isGrantLive({ expiresAt: new Date("2026-09-04T11:59:59Z"), revokedAt: null }, NOW)
    ).toBe(false);
  });

  it("is not live at the exact expiry instant (hard stop, not inclusive)", () => {
    expect(
      isGrantLive({ expiresAt: new Date("2026-09-04T12:00:00Z"), revokedAt: null }, NOW)
    ).toBe(false);
  });

  it("is not live once revoked, even if expiresAt is still in the future", () => {
    expect(
      isGrantLive(
        { expiresAt: new Date("2026-09-04T13:00:00Z"), revokedAt: new Date("2026-09-04T11:00:00Z") },
        NOW
      )
    ).toBe(false);
  });

  it("defaults `now` to the current time when omitted", () => {
    const future = new Date(Date.now() + 60_000);
    expect(isGrantLive({ expiresAt: future, revokedAt: null })).toBe(true);
  });
});

describe("clampSupportGrantDuration", () => {
  it("passes through a value within bounds", () => {
    expect(clampSupportGrantDuration(60)).toBe(60);
  });

  it("floors a fractional minute value", () => {
    expect(clampSupportGrantDuration(59.9)).toBe(59);
  });

  it("clamps up to the 5-minute floor", () => {
    expect(clampSupportGrantDuration(1)).toBe(5);
    expect(clampSupportGrantDuration(0)).toBe(5);
    expect(clampSupportGrantDuration(-100)).toBe(5);
  });

  it("clamps down to the 24-hour ceiling — no open-ended grants", () => {
    expect(clampSupportGrantDuration(24 * 60 + 1)).toBe(24 * 60);
    expect(clampSupportGrantDuration(999999)).toBe(24 * 60);
  });

  it("treats non-finite input as the minimum, not NaN/Infinity", () => {
    expect(clampSupportGrantDuration(NaN)).toBe(5);
    expect(clampSupportGrantDuration(Infinity)).toBe(5);
    expect(clampSupportGrantDuration(-Infinity)).toBe(5);
  });
});
