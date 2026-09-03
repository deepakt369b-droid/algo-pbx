import { describe, expect, it } from "vitest";
import {
  detectCriticalAlerts,
  isAlertDue,
  isConfiguredSecret,
  isHandshakeStale,
  classifySiteAlert,
  isValidIPv4,
  ALERT_RATE_LIMIT_MS,
  SITE_STALE_HANDSHAKE_MS,
} from "./gateway-alerts";

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

describe("isHandshakeStale", () => {
  it("is stale when there is no prior handshake", () => {
    expect(isHandshakeStale(null)).toBe(true);
  });

  it("is not stale within the threshold", () => {
    const now = new Date("2026-09-03T12:00:00Z");
    const lastHandshakeAt = new Date(now.getTime() - SITE_STALE_HANDSHAKE_MS + 1000);
    expect(isHandshakeStale(lastHandshakeAt, now)).toBe(false);
  });

  it("is stale once the threshold has fully elapsed", () => {
    const now = new Date("2026-09-03T12:00:00Z");
    const lastHandshakeAt = new Date(now.getTime() - SITE_STALE_HANDSHAKE_MS - 1000);
    expect(isHandshakeStale(lastHandshakeAt, now)).toBe(true);
  });
});

describe("classifySiteAlert", () => {
  const now = new Date("2026-09-03T12:00:00Z");
  const fresh = new Date(now.getTime() - 60_000);
  const stale = new Date(now.getTime() - SITE_STALE_HANDSHAKE_MS - 60_000);

  it("never alerts for TAILSCALE sites (legacy, out of scope for this poller)", () => {
    expect(
      classifySiteAlert({ transport: "TAILSCALE", connectedInStatusSource: false, lastHandshakeAt: null, pingOk: false, now })
    ).toBeNull();
  });

  it("is healthy for a HEADSCALE site the CLI reports online", () => {
    expect(
      classifySiteAlert({ transport: "HEADSCALE", connectedInStatusSource: true, lastHandshakeAt: null, pingOk: null, now })
    ).toBeNull();
  });

  it("flags a HEADSCALE site the CLI reports offline", () => {
    expect(
      classifySiteAlert({ transport: "HEADSCALE", connectedInStatusSource: false, lastHandshakeAt: null, pingOk: null, now })
    ).toBe("headscale.node_offline");
  });

  it("is healthy for an OPENVPN site with a fresh handshake and a successful ping", () => {
    expect(
      classifySiteAlert({ transport: "OPENVPN", connectedInStatusSource: true, lastHandshakeAt: fresh, pingOk: true, now })
    ).toBeNull();
  });

  it("flags a stale OpenVPN handshake even if not in the status log at all", () => {
    expect(
      classifySiteAlert({ transport: "OPENVPN", connectedInStatusSource: false, lastHandshakeAt: null, pingOk: null, now })
    ).toBe("vpn.handshake_stale");
  });

  it("flags a stale handshake over an unreachable ping (handshake staleness takes priority)", () => {
    expect(
      classifySiteAlert({ transport: "OPENVPN", connectedInStatusSource: true, lastHandshakeAt: stale, pingOk: false, now })
    ).toBe("vpn.handshake_stale");
  });

  it("flags an unreachable tunnel ping when the handshake is otherwise fresh", () => {
    expect(
      classifySiteAlert({ transport: "OPENVPN", connectedInStatusSource: true, lastHandshakeAt: fresh, pingOk: false, now })
    ).toBe("vpn.tunnel_unreachable");
  });

  it("does not alert on an unconfirmed ping (null) when the handshake is fresh", () => {
    expect(
      classifySiteAlert({ transport: "OPENVPN", connectedInStatusSource: true, lastHandshakeAt: fresh, pingOk: null, now })
    ).toBeNull();
  });
});

describe("isValidIPv4", () => {
  it("accepts a well-formed address", () => {
    expect(isValidIPv4("10.8.0.10")).toBe(true);
  });

  it("accepts boundary octet values", () => {
    expect(isValidIPv4("0.0.0.0")).toBe(true);
    expect(isValidIPv4("255.255.255.255")).toBe(true);
  });

  it("rejects an out-of-range octet", () => {
    expect(isValidIPv4("10.8.0.256")).toBe(false);
  });

  it("rejects too few or too many octets", () => {
    expect(isValidIPv4("10.8.0")).toBe(false);
    expect(isValidIPv4("10.8.0.1.5")).toBe(false);
  });

  it("rejects a leading-zero octet (ambiguous, some parsers read as octal)", () => {
    expect(isValidIPv4("10.8.0.010")).toBe(false);
  });

  it("rejects command-injection-shaped input outright", () => {
    expect(isValidIPv4("10.8.0.1; rm -rf /")).toBe(false);
    expect(isValidIPv4("$(whoami)")).toBe(false);
  });
});
