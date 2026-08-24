import { describe, expect, it } from "vitest";
import { assertScannableCidr, hostsInCidr, intToIp, ipToInt } from "./dinstar-discovery";

describe("ipToInt / intToIp", () => {
  it("round-trips", () => {
    expect(intToIp(ipToInt("192.168.1.50"))).toBe("192.168.1.50");
  });
});

describe("assertScannableCidr", () => {
  it("allows RFC1918 10.0.0.0/8", () => {
    expect(() => assertScannableCidr("10.1.2.0/24")).not.toThrow();
  });
  it("allows RFC1918 172.16.0.0/12", () => {
    expect(() => assertScannableCidr("172.20.0.0/24")).not.toThrow();
  });
  it("allows RFC1918 192.168.0.0/16", () => {
    expect(() => assertScannableCidr("192.168.1.0/24")).not.toThrow();
  });
  it("allows the CGNAT/Tailscale 100.64.0.0/10 range", () => {
    expect(() => assertScannableCidr("100.100.0.0/24")).not.toThrow();
  });
  it("refuses a public CIDR", () => {
    expect(() => assertScannableCidr("8.8.8.0/24")).toThrow(/outside the allowed scan ranges/);
  });
  it("refuses a public single-host CIDR", () => {
    expect(() => assertScannableCidr("1.1.1.1/32")).toThrow(/outside the allowed scan ranges/);
  });
  it("refuses a CIDR larger than a /24", () => {
    expect(() => assertScannableCidr("10.0.0.0/16")).toThrow(/too large to scan/);
  });
});

describe("hostsInCidr", () => {
  it("excludes network and broadcast addresses for a /24", () => {
    const hosts = hostsInCidr("192.168.1.0/24");
    expect(hosts).toHaveLength(254);
    expect(hosts[0]).toBe("192.168.1.1");
    expect(hosts[hosts.length - 1]).toBe("192.168.1.254");
    expect(hosts).not.toContain("192.168.1.0");
    expect(hosts).not.toContain("192.168.1.255");
  });
});
