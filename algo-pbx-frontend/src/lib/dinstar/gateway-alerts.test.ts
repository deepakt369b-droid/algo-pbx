import { describe, expect, it } from "vitest";
import { detectCriticalAlerts, isAlertDue, isConfiguredSecret, ALERT_RATE_LIMIT_MS } from "./gateway-alerts";

describe("detectCriticalAlerts", () => {
  it("returns empty for a batch with no critical event types", () => {
    const result = detectCriticalAlerts([
      { eventType: "gsm.port_registered", port: 0, message: "registered" },
      { eventType: null, port: null, message: "unrelated" },
    ]);
    expect(result).toEqual([]);
  });

  it("detects a single critical event", () => {
    const result = detectCriticalAlerts([{ eventType: "gsm.forbid_call", port: 0, message: "FORBID CALL" }]);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("gsm.forbid_call");
  });

  it("dedupes repeated critical types within one batch, keeping the first", () => {
    const result = detectCriticalAlerts([
      { eventType: "sip.trunk_unreachable", port: null, message: "first" },
      { eventType: "sip.trunk_unreachable", port: null, message: "second" },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].event.message).toBe("first");
  });

  it("detects multiple distinct critical types in one batch", () => {
    const result = detectCriticalAlerts([
      { eventType: "gsm.forbid_call", port: 0, message: "a" },
      { eventType: "gsm.port_unregistered", port: 1, message: "b" },
      { eventType: "sip.trunk_unreachable", port: null, message: "c" },
    ]);
    expect(result.map((r) => r.type).sort()).toEqual(
      ["gsm.forbid_call", "gsm.port_unregistered", "sip.trunk_unreachable"].sort()
    );
  });
});

describe("isAlertDue", () => {
  it("is due when there is no prior alert", () => {
    expect(isAlertDue(null)).toBe(true);
  });

  it("is not due immediately after a prior alert", () => {
    const now = new Date("2026-09-03T12:00:00Z");
    const lastSentAt = new Date("2026-09-03T11:59:00Z");
    expect(isAlertDue(lastSentAt, now)).toBe(false);
  });

  it("is due once the rate-limit window has fully elapsed", () => {
    const lastSentAt = new Date("2026-09-03T12:00:00Z");
    const now = new Date(lastSentAt.getTime() + ALERT_RATE_LIMIT_MS);
    expect(isAlertDue(lastSentAt, now)).toBe(true);
  });

  it("is not due one millisecond before the window elapses", () => {
    const lastSentAt = new Date("2026-09-03T12:00:00Z");
    const now = new Date(lastSentAt.getTime() + ALERT_RATE_LIMIT_MS - 1);
    expect(isAlertDue(lastSentAt, now)).toBe(false);
  });
});

describe("isConfiguredSecret", () => {
  it("is false for undefined", () => {
    expect(isConfiguredSecret(undefined)).toBe(false);
  });

  it("is false for an empty string", () => {
    expect(isConfiguredSecret("")).toBe(false);
  });

  it("is false for the unrotated .env placeholder", () => {
    expect(isConfiguredSecret("change-me")).toBe(false);
  });

  it("is true for a real-looking value", () => {
    expect(isConfiguredSecret("re_123abc")).toBe(true);
  });
});
