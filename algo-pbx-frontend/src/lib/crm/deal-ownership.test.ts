import { describe, expect, it } from "vitest";
import { canWriteDeal } from "./deal-ownership";

describe("canWriteDeal", () => {
  it("allows the owning agent to write their own deal", () => {
    expect(canWriteDeal({ role: "AGENT", userId: "u1", ownerId: "u1" })).toBe(true);
  });

  it("blocks a different agent from writing an owned deal", () => {
    expect(canWriteDeal({ role: "AGENT", userId: "u2", ownerId: "u1" })).toBe(false);
  });

  it("always allows SUPERVISOR regardless of owner", () => {
    expect(canWriteDeal({ role: "SUPERVISOR", userId: "u2", ownerId: "u1" })).toBe(true);
  });

  it("always allows ADMIN regardless of owner", () => {
    expect(canWriteDeal({ role: "ADMIN", userId: "u2", ownerId: "u1" })).toBe(true);
  });
});
