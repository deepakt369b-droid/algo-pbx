import { describe, expect, it } from "vitest";
import { assertScannableCidr, assertProbeableHost, hostsInCidr, intToIp, ipToInt } from "./dinstar-discovery";

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

describe("assertProbeableHost (Loop B4 — SSRF guard on the probe/apply routes)", () => {
  it("accepts a bare private IPv4", () => {
    expect(assertProbeableHost("192.168.11.1")).toBe("192.168.11.1");
    expect(assertProbeableHost("10.1.2.3")).toBe("10.1.2.3");
    expect(assertProbeableHost(" 172.16.5.5 ")).toBe("172.16.5.5");
  });
  it("accepts a private IPv4 with a port", () => {
    expect(assertProbeableHost("192.168.11.1:8080")).toBe("192.168.11.1:8080");
  });
  it("rejects a path or query string (the SSRF payload shape)", () => {
    expect(() => assertProbeableHost("169.254.169.254/latest/meta-data/?x=")).toThrow(/not a bare IPv4/);
    expect(() => assertProbeableHost("192.168.11.1/foo")).toThrow();
  });
  it("rejects hostnames and docker-internal names", () => {
    expect(() => assertProbeableHost("host.docker.internal")).toThrow();
    expect(() => assertProbeableHost("web")).toThrow();
  });
  it("rejects public IPs and the link-local metadata address", () => {
    expect(() => assertProbeableHost("8.8.8.8")).toThrow(/outside the allowed ranges/);
    expect(() => assertProbeableHost("169.254.169.254")).toThrow(/outside the allowed ranges/);
  });
  it("accepts the CGNAT/Tailscale range where the gateway can live", () => {
    expect(assertProbeableHost("100.64.1.2")).toBe("100.64.1.2");
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
