import { describe, expect, it } from "vitest";
import { normalizeToE164 } from "./phone-normalize";

describe("normalizeToE164", () => {
  it("passes through an already-E.164 UAE number unchanged", () => {
    expect(normalizeToE164("+971501234567")).toBe("+971501234567");
  });

  it("normalizes a bare national-format UAE number by assuming the AE default country", () => {
    expect(normalizeToE164("0501234567")).toBe("+971501234567");
  });

  it("normalizes a number from a different country when it carries its own country code", () => {
    expect(normalizeToE164("+14155552671")).toBe("+14155552671");
  });

  it("returns null for an unparseable string", () => {
    expect(normalizeToE164("not a number")).toBeNull();
  });

  it("returns null for an empty or whitespace-only string", () => {
    expect(normalizeToE164("")).toBeNull();
    expect(normalizeToE164("   ")).toBeNull();
  });

  it("returns null for a string that's too short to be a valid number", () => {
    expect(normalizeToE164("123")).toBeNull();
  });

  it("tolerates common formatting punctuation", () => {
    expect(normalizeToE164("+971 50 123 4567")).toBe("+971501234567");
    expect(normalizeToE164("(050) 123-4567")).toBe("+971501234567");
  });
});
