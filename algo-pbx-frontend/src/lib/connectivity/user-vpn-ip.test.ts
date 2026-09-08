import { describe, it, expect } from "vitest";
import { nextUserVpnIp } from "./user-vpn-ip";

describe("nextUserVpnIp", () => {
  it("returns the first host address in range when nothing is taken", () => {
    expect(nextUserVpnIp("10.8.3.0/24", [])).toBe("10.8.3.20");
  });

  it("skips taken addresses in order", () => {
    expect(nextUserVpnIp("10.8.3.0/24", ["10.8.3.20", "10.8.3.21"])).toBe("10.8.3.22");
  });

  it("returns null once the host range is exhausted", () => {
    const taken = [];
    for (let h = 20; h <= 254; h++) taken.push(`10.8.3.${h}`);
    expect(nextUserVpnIp("10.8.3.0/24", taken)).toBeNull();
  });

  it("returns null for a malformed CIDR", () => {
    expect(nextUserVpnIp("not-a-cidr", [])).toBeNull();
  });

  it("returns null for an unsupported prefix length", () => {
    expect(nextUserVpnIp("10.8.3.0/16", [])).toBeNull();
  });

  it("is unaffected by IPs from a different subnet in the taken list", () => {
    expect(nextUserVpnIp("10.8.3.0/24", ["10.8.4.20"])).toBe("10.8.3.20");
  });
});
