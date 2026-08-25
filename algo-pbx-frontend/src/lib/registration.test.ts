import { describe, expect, it } from "vitest";
import { isProfileComplete } from "./registration";

describe("isProfileComplete", () => {
  it("is false when any field is missing", () => {
    expect(isProfileComplete({ name: "", address: "a", phoneE164: "+911234567890", phoneVerifiedAt: new Date() })).toBe(false);
    expect(isProfileComplete({ name: "A", address: "", phoneE164: "+911234567890", phoneVerifiedAt: new Date() })).toBe(false);
    expect(isProfileComplete({ name: "A", address: "a", phoneE164: null, phoneVerifiedAt: new Date() })).toBe(false);
  });

  it("is false when the phone exists but is unverified", () => {
    expect(isProfileComplete({ name: "A", address: "a", phoneE164: "+911234567890", phoneVerifiedAt: null })).toBe(false);
  });

  it("is true only when name, address, phone, and a verification timestamp all exist", () => {
    expect(isProfileComplete({ name: "A", address: "a", phoneE164: "+911234567890", phoneVerifiedAt: new Date() })).toBe(true);
  });
});
