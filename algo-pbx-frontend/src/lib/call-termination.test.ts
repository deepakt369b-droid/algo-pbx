import { describe, expect, it } from "vitest";
import { classifyTermination } from "./call-termination";

describe("classifyTermination", () => {
  it("returns no message for an ordinary hangup", () => {
    const verdict = classifyTermination({ holdInFlight: false, transferInFlight: false });
    expect(verdict.resetState).toBe(true);
    expect(verdict.message).toBeNull();
  });

  it("returns a hold-specific message when a hold re-INVITE was in flight", () => {
    const verdict = classifyTermination({ holdInFlight: true, transferInFlight: false });
    expect(verdict.resetState).toBe(true);
    expect(verdict.message).toMatch(/hold/i);
  });

  it("returns a transfer-specific message when a transfer REFER was in flight", () => {
    const verdict = classifyTermination({ holdInFlight: false, transferInFlight: true });
    expect(verdict.resetState).toBe(true);
    expect(verdict.message).toMatch(/transfer/i);
  });

  it("prefers the transfer message when both are somehow in flight", () => {
    const verdict = classifyTermination({ holdInFlight: true, transferInFlight: true });
    expect(verdict.message).toMatch(/transfer/i);
  });
});
