import { describe, it, expect } from "vitest";
import {
  buildAttentionQueue,
  countBySeverity,
  PAID_UNTIL_WARNING_DAYS,
  GRANT_EXPIRY_WARNING_HOURS,
  type AttentionInputs,
} from "./attention-queue";

const NOW = new Date("2026-09-05T12:00:00.000Z");
const hours = (n: number) => new Date(NOW.getTime() + n * 60 * 60 * 1000);
const days = (n: number) => new Date(NOW.getTime() + n * 24 * 60 * 60 * 1000);

function inputs(overrides: Partial<AttentionInputs> = {}): AttentionInputs {
  return { tenants: [], gatewaySites: [], supportGrants: [], failedDeliveries: [], ...overrides };
}

function tenant(o: Partial<AttentionInputs["tenants"][number]> = {}): AttentionInputs["tenants"][number] {
  return {
    id: "t1",
    slug: "acme",
    name: "Acme Ltd",
    status: "ACTIVE",
    paidUntil: days(90),
    complianceComplete: true,
    complianceSummary: "",
    provisioningIncomplete: false,
    provisioningNextStepLabel: null,
    ...o,
  };
}

describe("the deep-link guarantee", () => {
  it("gives every item a non-empty href", () => {
    const items = buildAttentionQueue(
      inputs({
        tenants: [
          tenant({ complianceComplete: false, complianceSummary: "2 outstanding", paidUntil: days(3) }),
          tenant({ id: "t2", slug: "beta", provisioningIncomplete: true, provisioningNextStepLabel: "Issue cert" }),
        ],
        gatewaySites: [
          { id: "g1", tenantId: "t1", tenantSlug: "acme", name: "cust-acme-gw-1", lastHandshakeAt: null, status: "UNKNOWN" },
          { id: "g2", tenantId: "t2", tenantSlug: "beta", name: "cust-beta-gw-1", lastHandshakeAt: NOW, status: "DOWN" },
        ],
        supportGrants: [
          { id: "sg1", tenantId: "t1", tenantSlug: "acme", platformUserEmail: "ops@x.com", expiresAt: hours(1) },
        ],
        failedDeliveries: [{ tenantId: "t1", tenantSlug: "acme", count: 3 }],
      }),
      NOW
    );

    expect(items.length).toBeGreaterThan(5);
    for (const i of items) {
      expect(i.href).toBeTruthy();
      expect(i.href.startsWith("/platform/")).toBe(true);
    }
  });

  it("links each item to the tab that actually fixes it", () => {
    const items = buildAttentionQueue(
      inputs({
        tenants: [tenant({ paidUntil: days(3), complianceComplete: false, complianceSummary: "x" })],
        failedDeliveries: [{ tenantId: "t1", tenantSlug: "acme", count: 1 }],
        supportGrants: [
          { id: "sg1", tenantId: "t1", tenantSlug: "acme", platformUserEmail: "ops@x.com", expiresAt: hours(1) },
        ],
      }),
      NOW
    );
    const href = (prefix: string) => items.find((i) => i.id.startsWith(prefix))?.href;

    expect(href("paid-until:")).toBe("/platform/tenants/t1?tab=billing");
    expect(href("compliance:")).toBe("/platform/tenants/t1?tab=identity");
    expect(href("delivery:")).toBe("/platform/tenants/t1?tab=gateway");
    expect(href("grant:")).toBe("/platform/tenants/t1?tab=support");
  });
});

describe("severity assignment", () => {
  it("treats failed deliveries and downed tunnels as critical", () => {
    const items = buildAttentionQueue(
      inputs({
        failedDeliveries: [{ tenantId: "t1", tenantSlug: "acme", count: 2 }],
        gatewaySites: [
          { id: "g1", tenantId: "t1", tenantSlug: "acme", name: "gw", lastHandshakeAt: NOW, status: "DOWN" },
        ],
      }),
      NOW
    );
    expect(items.every((i) => i.severity === "critical")).toBe(true);
  });

  it("treats a never-connected tunnel as a warning, not an outage", () => {
    // It has never worked, so nothing has broken — it is a provisioning gap.
    const items = buildAttentionQueue(
      inputs({
        gatewaySites: [
          { id: "g1", tenantId: "t1", tenantSlug: "acme", name: "gw", lastHandshakeAt: null, status: "UNKNOWN" },
        ],
      }),
      NOW
    );
    expect(items[0].severity).toBe("warning");
    expect(items[0].detail).toMatch(/Provisioning beyond cert issuance is blocked/);
  });

  it("keeps compliance gaps as info — visible, but not blocking", () => {
    const items = buildAttentionQueue(
      inputs({ tenants: [tenant({ complianceComplete: false, complianceSummary: "2 outstanding" })] }),
      NOW
    );
    expect(items[0].severity).toBe("info");
    expect(items[0].detail).toBe("2 outstanding");
  });
});

describe("thresholds", () => {
  it.each([0, 1, PAID_UNTIL_WARNING_DAYS])("flags paidUntil %i days away", (d) => {
    const items = buildAttentionQueue(inputs({ tenants: [tenant({ paidUntil: days(d) })] }), NOW);
    expect(items.some((i) => i.id.startsWith("paid-until:"))).toBe(true);
  });

  it("stays quiet for paidUntil beyond the window", () => {
    const items = buildAttentionQueue(
      inputs({ tenants: [tenant({ paidUntil: days(PAID_UNTIL_WARNING_DAYS + 1) })] }),
      NOW
    );
    expect(items).toEqual([]);
  });

  it("reassures that billing never affects calls", () => {
    const items = buildAttentionQueue(inputs({ tenants: [tenant({ paidUntil: days(3) })] }), NOW);
    expect(items[0].detail).toMatch(/Calls are never affected by billing/);
  });

  it("flags a grant expiring inside the window but not one further out", () => {
    const near = { id: "a", tenantId: "t1", tenantSlug: "acme", platformUserEmail: "o@x.com", expiresAt: hours(1) };
    const far = { ...near, id: "b", expiresAt: hours(GRANT_EXPIRY_WARNING_HOURS + 1) };
    const items = buildAttentionQueue(inputs({ supportGrants: [near, far] }), NOW);
    expect(items.map((i) => i.id)).toEqual(["grant:a"]);
  });

  it("ignores an already-expired grant — it is gone, not urgent", () => {
    const items = buildAttentionQueue(
      inputs({
        supportGrants: [
          { id: "a", tenantId: "t1", tenantSlug: "acme", platformUserEmail: "o@x.com", expiresAt: hours(-1) },
        ],
      }),
      NOW
    );
    expect(items).toEqual([]);
  });

  it("ignores a zero failed-delivery count", () => {
    expect(buildAttentionQueue(inputs({ failedDeliveries: [{ tenantId: "t1", tenantSlug: "acme", count: 0 }] }), NOW)).toEqual([]);
  });
});

describe("exclusions", () => {
  it("says nothing about an offboarded tenant", () => {
    const items = buildAttentionQueue(
      inputs({
        tenants: [
          tenant({ status: "OFFBOARDED", paidUntil: days(1), complianceComplete: false, complianceSummary: "x", provisioningIncomplete: true }),
        ],
      }),
      NOW
    );
    expect(items).toEqual([]);
  });

  it("does not chase payment on an already-suspended tenant", () => {
    const items = buildAttentionQueue(inputs({ tenants: [tenant({ status: "SUSPENDED", paidUntil: days(2) })] }), NOW);
    expect(items.some((i) => i.id.startsWith("paid-until:"))).toBe(false);
  });

  it("returns an empty queue for a healthy platform", () => {
    expect(buildAttentionQueue(inputs({ tenants: [tenant()] }), NOW)).toEqual([]);
  });
});

describe("ordering", () => {
  it("puts critical before warning before info", () => {
    const items = buildAttentionQueue(
      inputs({
        tenants: [tenant({ complianceComplete: false, complianceSummary: "x", provisioningIncomplete: true })],
        failedDeliveries: [{ tenantId: "t1", tenantSlug: "acme", count: 1 }],
      }),
      NOW
    );
    expect(items.map((i) => i.severity)).toEqual(["critical", "warning", "info"]);
  });

  it("is deterministic for the same input", () => {
    const i = inputs({
      tenants: [tenant({ complianceComplete: false, complianceSummary: "x" }), tenant({ id: "t2", slug: "b", complianceComplete: false, complianceSummary: "y" })],
    });
    expect(buildAttentionQueue(i, NOW)).toEqual(buildAttentionQueue(i, NOW));
  });

  it("gives every item a unique id", () => {
    const items = buildAttentionQueue(
      inputs({
        tenants: [tenant({ paidUntil: days(1), complianceComplete: false, complianceSummary: "x", provisioningIncomplete: true })],
        failedDeliveries: [{ tenantId: "t1", tenantSlug: "acme", count: 1 }],
      }),
      NOW
    );
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });
});

describe("countBySeverity", () => {
  it("tallies the bands", () => {
    const items = buildAttentionQueue(
      inputs({
        tenants: [tenant({ complianceComplete: false, complianceSummary: "x" })],
        failedDeliveries: [{ tenantId: "t1", tenantSlug: "acme", count: 1 }],
      }),
      NOW
    );
    expect(countBySeverity(items)).toEqual({ critical: 1, warning: 0, info: 1 });
  });

  it("returns zeros for an empty queue", () => {
    expect(countBySeverity([])).toEqual({ critical: 0, warning: 0, info: 0 });
  });
});
