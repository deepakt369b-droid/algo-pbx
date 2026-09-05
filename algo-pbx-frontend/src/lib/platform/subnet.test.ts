import { describe, it, expect } from "vitest";
import {
  allocateSubnetIndex,
  subnetCidr,
  tunnelServerIp,
  gatewayTunnelIp,
  certCn,
  telephonyNamespace,
  pjsipEndpointName,
  dialplanContexts,
  isLegacyPooledTenant,
  SubnetExhaustedError,
  MAX_SUBNET_INDEX,
} from "./subnet";
import { validateTenantSlug } from "@/lib/tenant/slug";

describe("allocateSubnetIndex", () => {
  it("starts new tenants at 1, leaving 0 to the legacy tenant", () => {
    expect(allocateSubnetIndex([])).toBe(1);
    expect(allocateSubnetIndex([0])).toBe(1);
  });

  it("returns max + 1", () => {
    expect(allocateSubnetIndex([0, 1, 2])).toBe(3);
  });

  // The rule this repo cares most about in this file.
  it("NEVER reuses a gap left by an offboarded tenant", () => {
    // 2 was offboarded and its index freed in the list. A "smallest gap"
    // allocator would return 2 and hand a new customer the /24 that a
    // revoked-but-still-deployed gateway is configured to dial into.
    expect(allocateSubnetIndex([0, 1, 3, 4])).toBe(5);
    expect(allocateSubnetIndex([0, 5])).toBe(6);
  });

  it("is unaffected by ordering, duplicates or junk entries", () => {
    expect(allocateSubnetIndex([4, 1, 4, 0, 2])).toBe(5);
    expect(allocateSubnetIndex([1, -3, 2.5, 2])).toBe(3);
  });

  it("throws rather than wrapping when the /16 is exhausted", () => {
    expect(() => allocateSubnetIndex([MAX_SUBNET_INDEX])).toThrow(SubnetExhaustedError);
  });
});

describe("address derivations", () => {
  it("gives tenant n the 10.8.n.0/24", () => {
    expect(subnetCidr(0)).toBe("10.8.0.0/24");
    expect(subnetCidr(7)).toBe("10.8.7.0/24");
    expect(subnetCidr(255)).toBe("10.8.255.0/24");
  });

  it("puts the server on .1 and the gateway on .10, inside the tenant's own /24", () => {
    expect(tunnelServerIp(3)).toBe("10.8.3.1");
    expect(gatewayTunnelIp(3)).toBe("10.8.3.10");
  });

  it("matches the deployed tenant #1 addresses exactly", () => {
    // cust-demo-gw-1 lives at 10.8.0.10 today; the scheme must reproduce the
    // reality that already exists rather than renumbering a live tunnel.
    expect(gatewayTunnelIp(0)).toBe("10.8.0.10");
    expect(tunnelServerIp(0)).toBe("10.8.0.1");
  });

  it.each([-1, 256, 1.5, NaN])("rejects out-of-range index %s", (n) => {
    expect(() => subnetCidr(n as number)).toThrow(RangeError);
  });
});

describe("certCn — cert CN == ccd filename == GatewaySite.name", () => {
  it("builds the documented convention", () => {
    expect(certCn("acme")).toBe("cust-acme-gw-1");
    expect(certCn("acme", 2)).toBe("cust-acme-gw-2");
  });

  it("reproduces the already-issued cert name for the demo gateway", () => {
    expect(certCn("demo")).toBe("cust-demo-gw-1");
  });

  // The load-bearing cross-check: bridge-watch.sh matches ccd filenames
  // against the CN presented at connect time, so anything validateTenantSlug
  // accepts must also satisfy SAFE_NAME_RE once wrapped in this template.
  const SAFE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

  it.each(["a", "acme", "acme-corp", "a1-b2-c3", "x".repeat(50)])(
    "produces a SAFE_NAME_RE-valid CN for accepted slug %s",
    (slug) => {
      expect(validateTenantSlug(slug).ok).toBe(true);
      expect(SAFE_NAME_RE.test(certCn(slug))).toBe(true);
    }
  );

  it("rejects a non-positive gateway number rather than emitting cust-x-gw-0", () => {
    expect(() => certCn("acme", 0)).toThrow(RangeError);
  });
});

describe("telephony namespace", () => {
  it("prefixes identities with t<n>-", () => {
    expect(telephonyNamespace(4)).toBe("t4-");
    expect(pjsipEndpointName(4, "1001")).toBe("t4-1001");
  });

  it("builds the two dialplan contexts without a trailing hyphen", () => {
    expect(dialplanContexts(4)).toEqual({
      fromAgent: "from-agent-t4",
      fromDinstar: "from-dinstar-t4",
    });
  });
});

describe("isLegacyPooledTenant", () => {
  it("flags the tenant that predates the scheme", () => {
    expect(isLegacyPooledTenant("saharatechs", 0)).toBe(true);
    expect(isLegacyPooledTenant("acme", 0)).toBe(true);
    expect(isLegacyPooledTenant("acme", 3)).toBe(false);
  });
});
