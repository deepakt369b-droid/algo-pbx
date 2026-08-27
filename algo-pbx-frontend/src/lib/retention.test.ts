import { describe, expect, it } from "vitest";
import { isExpired } from "./retention";

describe("isExpired", () => {
  const now = new Date("2026-08-27T00:00:00Z");

  it("returns false for something created within the retention window", () => {
    const createdAt = new Date("2026-08-01T00:00:00Z"); // 26 days ago
    expect(isExpired(createdAt, 90, now)).toBe(false);
  });

  it("returns true for something older than the retention window", () => {
    const createdAt = new Date("2026-01-01T00:00:00Z"); // ~238 days ago
    expect(isExpired(createdAt, 90, now)).toBe(true);
  });

  it("is a strict boundary at exactly retentionDays old", () => {
    const exactlyAtCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    expect(isExpired(exactlyAtCutoff, 90, now)).toBe(false);
    const justOverCutoff = new Date(exactlyAtCutoff.getTime() - 1);
    expect(isExpired(justOverCutoff, 90, now)).toBe(true);
  });

  it("never expires anything when retentionDays is 0 or negative (pruning disabled)", () => {
    const veryOld = new Date("2000-01-01T00:00:00Z");
    expect(isExpired(veryOld, 0, now)).toBe(false);
    expect(isExpired(veryOld, -5, now)).toBe(false);
  });
});
