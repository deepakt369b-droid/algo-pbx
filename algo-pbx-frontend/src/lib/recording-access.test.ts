import { describe, expect, it } from "vitest";
import { canAccessRecording } from "./recording-access";

const HIDDEN_AT = new Date("2026-08-24T00:00:00Z");

describe("canAccessRecording", () => {
  it("allows ADMIN regardless of ownership or hidden state", () => {
    expect(
      canAccessRecording({
        role: "ADMIN",
        callerExtension: "9999",
        cdrAgentExtension: "1001",
        hiddenFromAgentAt: HIDDEN_AT,
      })
    ).toBe(true);
  });

  it("allows SUPERVISOR regardless of ownership or hidden state", () => {
    expect(
      canAccessRecording({
        role: "SUPERVISOR",
        callerExtension: "9999",
        cdrAgentExtension: "1001",
        hiddenFromAgentAt: HIDDEN_AT,
      })
    ).toBe(true);
  });

  it("allows an AGENT who owns the call and it is not hidden", () => {
    expect(
      canAccessRecording({
        role: "AGENT",
        callerExtension: "1001",
        cdrAgentExtension: "1001",
        hiddenFromAgentAt: null,
      })
    ).toBe(true);
  });

  it("denies an AGENT who owns the call once it has been hidden", () => {
    expect(
      canAccessRecording({
        role: "AGENT",
        callerExtension: "1001",
        cdrAgentExtension: "1001",
        hiddenFromAgentAt: HIDDEN_AT,
      })
    ).toBe(false);
  });

  it("denies an AGENT who does not own the call, when not hidden", () => {
    expect(
      canAccessRecording({
        role: "AGENT",
        callerExtension: "1002",
        cdrAgentExtension: "1001",
        hiddenFromAgentAt: null,
      })
    ).toBe(false);
  });

  it("denies an AGENT who does not own the call, when hidden", () => {
    expect(
      canAccessRecording({
        role: "AGENT",
        callerExtension: "1002",
        cdrAgentExtension: "1001",
        hiddenFromAgentAt: HIDDEN_AT,
      })
    ).toBe(false);
  });

  it("denies an AGENT with no linked extension, even against a call with no agent assigned", () => {
    expect(
      canAccessRecording({
        role: "AGENT",
        callerExtension: null,
        cdrAgentExtension: null,
        hiddenFromAgentAt: null,
      })
    ).toBe(false);
  });
});
