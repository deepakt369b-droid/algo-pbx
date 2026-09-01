import { describe, expect, it } from "vitest";
import { canWriteContact } from "./contact-ownership";

describe("canWriteContact", () => {
  it("allows anyone to write an unowned contact", () => {
    expect(canWriteContact({ role: "AGENT", userId: "u1", ownerId: null })).toBe(true);
  });

  it("allows the owning agent to write their own contact", () => {
    expect(canWriteContact({ role: "AGENT", userId: "u1", ownerId: "u1" })).toBe(true);
  });

  it("blocks a different agent from writing an owned contact", () => {
    expect(canWriteContact({ role: "AGENT", userId: "u2", ownerId: "u1" })).toBe(false);
  });

  it("always allows SUPERVISOR regardless of owner", () => {
    expect(canWriteContact({ role: "SUPERVISOR", userId: "u2", ownerId: "u1" })).toBe(true);
  });

  it("always allows ADMIN regardless of owner", () => {
    expect(canWriteContact({ role: "ADMIN", userId: "u2", ownerId: "u1" })).toBe(true);
  });
});
