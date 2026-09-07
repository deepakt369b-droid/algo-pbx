import { describe, expect, it } from "vitest";
import { evaluateGeoAccess, isExemptIp, type GeoDecisionInput, type GeoLookup } from "./geo-decision";

const INDIA: GeoLookup = { country: "IN", asn: 1234, asnOrg: "Some Indian ISP" };
const PAKISTAN: GeoLookup = { country: "PK", asn: 5678, asnOrg: "Some Pakistani ISP" };
const DATACENTER_IN_INDIA: GeoLookup = { country: "IN", asn: 16509, asnOrg: "Amazon.com, Inc. (AWS)" };

function baseInput(overrides: Partial<GeoDecisionInput> = {}): GeoDecisionInput {
  return {
    ip: "203.0.113.5",
    lookup: INDIA,
    dbAvailable: true,
    allowedCountries: ["IN"],
    tenantDefaultCountry: null,
    mode: "enforce",
    blockVpn: false,
    currentAttempts: 0,
    threshold: 6,
    alreadyLocked: false,
    ...overrides,
  };
}

describe("evaluateGeoAccess — allowed country", () => {
  it("allows a login from an allowed country and resets the counter", () => {
    const decision = evaluateGeoAccess(baseInput({ currentAttempts: 3 }));
    expect(decision.outcome).toBe("allowed");
    expect(decision.allowed).toBe(true);
    expect(decision.shouldCount).toBe(false);
    expect(decision.shouldLock).toBe(false);
    expect(decision.shouldResetCounter).toBe(true);
    expect(decision.agentMessage).toBeNull();
  });

  it("never clears an existing lock even from the allowed country", () => {
    const decision = evaluateGeoAccess(baseInput({ alreadyLocked: true, lookup: INDIA }));
    expect(decision.allowed).toBe(false);
    expect(decision.shouldCount).toBe(false);
    expect(decision.agentMessage).toMatch(/locked/i);
  });
});

describe("evaluateGeoAccess — wrong country counts down 5 -> 0, 6th locks", () => {
  it("counts each wrong-country attempt and decrements remaining, 6th locks", () => {
    let attempts = 0;
    const expectedRemaining = [5, 4, 3, 2, 1, 0];
    for (let i = 0; i < 6; i++) {
      const decision = evaluateGeoAccess(baseInput({ lookup: PAKISTAN, currentAttempts: attempts }));
      expect(decision.outcome).toBe("wrong_country");
      expect(decision.allowed).toBe(false);
      expect(decision.shouldCount).toBe(true);
      expect(decision.remainingAttempts).toBe(expectedRemaining[i]);
      if (i < 5) {
        expect(decision.shouldLock).toBe(false);
        expect(decision.agentMessage).toMatch(/India/);
        expect(decision.agentMessage).toMatch(/Pakistan/);
      } else {
        expect(decision.shouldLock).toBe(true);
        expect(decision.agentMessage).toMatch(/locked/i);
      }
      attempts += 1;
    }
  });

  it("does NOT increment the counter for the 7th attempt once already locked", () => {
    const decision = evaluateGeoAccess(baseInput({ lookup: PAKISTAN, currentAttempts: 6, alreadyLocked: true }));
    expect(decision.allowed).toBe(false);
    expect(decision.shouldCount).toBe(false);
    expect(decision.shouldLock).toBe(false);
  });
});

describe("evaluateGeoAccess — geoBlockVpn toggle", () => {
  it("does NOT flag a datacenter ASN as a strike when blockVpn is false, if country matches", () => {
    const decision = evaluateGeoAccess(baseInput({ lookup: DATACENTER_IN_INDIA, blockVpn: false }));
    expect(decision.outcome).toBe("allowed");
    expect(decision.allowed).toBe(true);
    expect(decision.shouldCount).toBe(false);
  });

  it("flags a datacenter ASN as vpn_suspected when blockVpn is true, even if country matches", () => {
    const decision = evaluateGeoAccess(baseInput({ lookup: DATACENTER_IN_INDIA, blockVpn: true }));
    expect(decision.outcome).toBe("vpn_suspected");
    expect(decision.allowed).toBe(false);
    expect(decision.shouldCount).toBe(true);
    expect(decision.agentMessage).toMatch(/VPN|hosting/i);
  });
});

describe("evaluateGeoAccess — fail open", () => {
  it("allows without counting when the geo database is unavailable", () => {
    const decision = evaluateGeoAccess(baseInput({ dbAvailable: false, lookup: null }));
    expect(decision.outcome).toBe("db_unavailable");
    expect(decision.allowed).toBe(true);
    expect(decision.shouldCount).toBe(false);
  });

  it("allows without counting when lookup is null even if dbAvailable is true", () => {
    const decision = evaluateGeoAccess(baseInput({ lookup: null }));
    expect(decision.outcome).toBe("db_unavailable");
    expect(decision.allowed).toBe(true);
    expect(decision.shouldCount).toBe(false);
  });

  it.each([
    ["unknown", "unknown"],
    ["10.0.0.0/8", "10.1.2.3"],
    ["172.16.0.0/12", "172.20.5.6"],
    ["192.168.0.0/16", "192.168.1.100"],
    ["100.64.0.0/10", "100.64.0.1"],
    ["loopback", "127.0.0.1"],
    ["ipv6 loopback", "::1"],
  ])("allows without counting for exempt IP category: %s", (_label, ip) => {
    const decision = evaluateGeoAccess(baseInput({ ip, lookup: PAKISTAN }));
    expect(decision.outcome).toBe("unknown_ip");
    expect(decision.allowed).toBe(true);
    expect(decision.shouldCount).toBe(false);
  });
});

describe("isExemptIp", () => {
  it("treats the getClientIp() unknown sentinel as exempt", () => {
    expect(isExemptIp("unknown")).toBe(true);
  });

  it("treats RFC1918 ranges as exempt", () => {
    expect(isExemptIp("10.0.0.1")).toBe(true);
    expect(isExemptIp("172.16.0.1")).toBe(true);
    expect(isExemptIp("172.31.255.255")).toBe(true);
    expect(isExemptIp("192.168.0.1")).toBe(true);
  });

  it("treats 172.15.x.x and 172.32.x.x as NOT exempt (just outside 172.16.0.0/12)", () => {
    expect(isExemptIp("172.15.255.255")).toBe(false);
    expect(isExemptIp("172.32.0.0")).toBe(false);
  });

  it("treats 100.64.0.0/10 (this stack's overlay CGNAT range) as exempt", () => {
    expect(isExemptIp("100.64.0.1")).toBe(true);
    expect(isExemptIp("100.127.255.255")).toBe(true);
  });

  it("treats 100.63.x.x and 100.128.x.x as NOT exempt (just outside 100.64.0.0/10)", () => {
    expect(isExemptIp("100.63.255.255")).toBe(false);
    expect(isExemptIp("100.128.0.0")).toBe(false);
  });

  it("treats loopback as exempt", () => {
    expect(isExemptIp("127.0.0.1")).toBe(true);
    expect(isExemptIp("::1")).toBe(true);
  });

  it("treats an ordinary public IP as NOT exempt", () => {
    expect(isExemptIp("203.0.113.5")).toBe(false);
    expect(isExemptIp("8.8.8.8")).toBe(false);
  });
});

describe("evaluateGeoAccess — unconfigured tenant never enforces", () => {
  it("allows when no allowed countries and no tenant default country are set", () => {
    const decision = evaluateGeoAccess(
      baseInput({ allowedCountries: [], tenantDefaultCountry: null, lookup: PAKISTAN })
    );
    expect(decision.outcome).toBe("allowed");
    expect(decision.allowed).toBe(true);
    expect(decision.shouldCount).toBe(false);
  });

  it("allows when geoLockMode is off", () => {
    const decision = evaluateGeoAccess(baseInput({ mode: "off", lookup: PAKISTAN }));
    expect(decision.allowed).toBe(true);
    expect(decision.shouldCount).toBe(false);
  });

  it("allows when geoLockMode is null", () => {
    const decision = evaluateGeoAccess(baseInput({ mode: null, lookup: PAKISTAN }));
    expect(decision.allowed).toBe(true);
    expect(decision.shouldCount).toBe(false);
  });

  it("falls back to tenantDefaultCountry when the extension has no allowedCountries set", () => {
    const decision = evaluateGeoAccess(
      baseInput({ allowedCountries: [], tenantDefaultCountry: "IN", lookup: PAKISTAN })
    );
    expect(decision.outcome).toBe("wrong_country");
    expect(decision.allowed).toBe(false);
    expect(decision.shouldCount).toBe(true);
  });
});

describe("evaluateGeoAccess — monitor mode", () => {
  it("allows a wrong-country login but reports monitor_only without counting", () => {
    const decision = evaluateGeoAccess(baseInput({ mode: "monitor", lookup: PAKISTAN, currentAttempts: 2 }));
    expect(decision.outcome).toBe("monitor_only");
    expect(decision.allowed).toBe(true);
    expect(decision.shouldCount).toBe(false);
    expect(decision.shouldLock).toBe(false);
    expect(decision.agentMessage).toBeNull();
  });

  it("reports monitor_only for a would-be vpn_suspected case when blockVpn is on", () => {
    const decision = evaluateGeoAccess(
      baseInput({ mode: "monitor", lookup: DATACENTER_IN_INDIA, blockVpn: true })
    );
    expect(decision.outcome).toBe("monitor_only");
    expect(decision.allowed).toBe(true);
    expect(decision.shouldCount).toBe(false);
  });

  it("reports plain allowed (not monitor_only) for a clean login in monitor mode", () => {
    const decision = evaluateGeoAccess(baseInput({ mode: "monitor", lookup: INDIA }));
    expect(decision.outcome).toBe("allowed");
    expect(decision.allowed).toBe(true);
  });

  it("allows even an already-locked extension in monitor mode", () => {
    const decision = evaluateGeoAccess(
      baseInput({ mode: "monitor", lookup: PAKISTAN, alreadyLocked: true })
    );
    expect(decision.allowed).toBe(true);
    expect(decision.shouldCount).toBe(false);
  });
});
