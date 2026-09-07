import { describe, expect, it } from "vitest";
import { DATACENTER_ASNS, isDatacenterAsn, isDatacenterOrgName } from "./datacenter-asns";

describe("isDatacenterAsn", () => {
  it("recognizes well-known cloud/hosting ASNs", () => {
    expect(isDatacenterAsn(16509)).toBe(true); // AWS
    expect(isDatacenterAsn(15169)).toBe(true); // Google
    expect(isDatacenterAsn(8075)).toBe(true); // Azure
    expect(isDatacenterAsn(14061)).toBe(true); // DigitalOcean
    expect(isDatacenterAsn(24940)).toBe(true); // Hetzner
    expect(isDatacenterAsn(16276)).toBe(true); // OVH
  });

  it("rejects an ASN not on the list", () => {
    expect(isDatacenterAsn(1)).toBe(false);
    expect(isDatacenterAsn(999999999)).toBe(false);
  });

  it("has a substantial, non-trivial list", () => {
    expect(DATACENTER_ASNS.size).toBeGreaterThan(50);
  });
});

describe("isDatacenterOrgName", () => {
  it("matches common hosting/vpn/cloud keywords case-insensitively", () => {
    expect(isDatacenterOrgName("Example Hosting Ltd")).toBe(true);
    expect(isDatacenterOrgName("SUPER VPN SERVICES")).toBe(true);
    expect(isDatacenterOrgName("Acme Cloud Inc")).toBe(true);
    expect(isDatacenterOrgName("Some Datacenter Group")).toBe(true);
    expect(isDatacenterOrgName("Data Center Solutions")).toBe(true);
    expect(isDatacenterOrgName("Big Server Farm")).toBe(true);
    expect(isDatacenterOrgName("Colo4 Networks")).toBe(true);
    expect(isDatacenterOrgName("Proxy Networks LLC")).toBe(true);
  });

  it("does not match an ordinary residential/mobile ISP name", () => {
    expect(isDatacenterOrgName("Reliance Jio Infocomm Limited")).toBe(false);
    expect(isDatacenterOrgName("Bharti Airtel Ltd")).toBe(false);
  });

  it("handles an empty string safely", () => {
    expect(isDatacenterOrgName("")).toBe(false);
  });
});
