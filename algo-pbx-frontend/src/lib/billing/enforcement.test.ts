import { describe, it, expect } from "vitest";
import {
  evaluateBillingAccess,
  GRACE_PERIOD_DAYS,
  type BillingTenantView,
  type UiAccessState,
} from "./enforcement";

const NOW = new Date("2026-09-05T12:00:00.000Z");

function daysFromNow(days: number): Date {
  return new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);
}

function tenant(overrides: Partial<BillingTenantView> = {}): BillingTenantView {
  return {
    billingStatus: "ACTIVE",
    paidUntil: daysFromNow(30),
    status: "ACTIVE",
    ...overrides,
  };
}

describe("evaluateBillingAccess — the ladder", () => {
  it("is ok while paidUntil is in the future", () => {
    const state = evaluateBillingAccess(tenant({ paidUntil: daysFromNow(1) }), NOW);
    expect(state.rung).toBe("ok");
    expect(state.bannerText).toBeNull();
    expect(state.graceDaysRemaining).toBeNull();
  });

  it("is ok when paidUntil is null (trial/comped — never lock out on a blank field)", () => {
    const state = evaluateBillingAccess(tenant({ paidUntil: null, billingStatus: "TRIAL" }), NOW);
    expect(state.rung).toBe("ok");
  });

  // Rung 1: the plan's "paidUntil lapses -> 7-day in-app warning banner,
  // full access retained".
  it.each([
    [0, 7],
    [1, 6],
    [3, 4],
    [6, 1],
  ])("warns on day %i overdue with %i grace days left", (overdue, expectedRemaining) => {
    const state = evaluateBillingAccess(tenant({ paidUntil: daysFromNow(-overdue) }), NOW);
    expect(state.rung).toBe("warning");
    expect(state.graceDaysRemaining).toBe(expectedRemaining);
    expect(state.ownerExempt).toBe(false);
    expect(state.bannerText).toContain("not affected");
  });

  it("uses singular day wording at exactly one day remaining", () => {
    const state = evaluateBillingAccess(tenant({ paidUntil: daysFromNow(-6) }), NOW);
    expect(state.bannerText).toContain("in 1 day.");
  });

  // Rung 2: "After 7 days -> tenant login blocked, except the tenant OWNER".
  it.each([GRACE_PERIOD_DAYS, GRACE_PERIOD_DAYS + 1, 90])(
    "blocks login on day %i overdue, with the owner exemption",
    (overdue) => {
      const state = evaluateBillingAccess(tenant({ paidUntil: daysFromNow(-overdue) }), NOW);
      expect(state.rung).toBe("login_blocked");
      expect(state.ownerExempt).toBe(true);
    }
  );

  it("blocks the moment the grace window closes, not a day later", () => {
    expect(evaluateBillingAccess(tenant({ paidUntil: daysFromNow(-6) }), NOW).rung).toBe("warning");
    expect(evaluateBillingAccess(tenant({ paidUntil: daysFromNow(-7) }), NOW).rung).toBe("login_blocked");
  });
});

describe("evaluateBillingAccess — explicit owner decisions win over dates", () => {
  it("blocks a manually SUSPENDED tenant even with paidUntil far in the future", () => {
    const state = evaluateBillingAccess(tenant({ status: "SUSPENDED", paidUntil: daysFromNow(365) }), NOW);
    expect(state.rung).toBe("login_blocked");
    expect(state.ownerExempt).toBe(true);
  });

  it("blocks a SUSPENDED billingStatus the same way", () => {
    const state = evaluateBillingAccess(tenant({ billingStatus: "SUSPENDED" }), NOW);
    expect(state.rung).toBe("login_blocked");
  });

  it("blocks an OFFBOARDED tenant and mentions data export", () => {
    const state = evaluateBillingAccess(tenant({ status: "OFFBOARDED" }), NOW);
    expect(state.rung).toBe("login_blocked");
    expect(state.bannerText).toContain("export");
  });

  it("restores access immediately once paidUntil is extended (owner override, rung 3)", () => {
    const lapsed = tenant({ paidUntil: daysFromNow(-30), billingStatus: "PAST_DUE" });
    expect(evaluateBillingAccess(lapsed, NOW).rung).toBe("login_blocked");

    const marked = { ...lapsed, paidUntil: daysFromNow(30), billingStatus: "ACTIVE" as const };
    expect(evaluateBillingAccess(marked, NOW).rung).toBe("ok");
  });
});

// ============================================================================
// The structural guarantee. Plan §5: "The enforcement function must reflect
// this in its type: it returns a UI access state, and has no
// telephony-affecting return value at all. That way the separation is
// structural rather than remembered."
//
// This suite is the "remembered" part made mechanical. If someone adds a
// `suspendCalls` field to UiAccessState, these fail — which is the point,
// because that field would be the automatic path to a dialplan cut that the
// plan forbids outright.
// ============================================================================
describe("evaluateBillingAccess — telephony separation is structural", () => {
  const FORBIDDEN = [
    "call", "calls", "telephony", "dialplan", "pjsip", "asterisk", "ami",
    "trunk", "sip", "inbound", "outbound", "endpoint", "queue", "extension",
  ];

  const everyRung: BillingTenantView[] = [
    tenant({ paidUntil: daysFromNow(30) }),
    tenant({ paidUntil: daysFromNow(-1) }),
    tenant({ paidUntil: daysFromNow(-30) }),
    tenant({ status: "SUSPENDED" }),
    tenant({ status: "OFFBOARDED" }),
  ];

  it("returns no key that any telephony code could act on", () => {
    for (const t of everyRung) {
      const keys = Object.keys(evaluateBillingAccess(t, NOW)).map((k) => k.toLowerCase());
      for (const key of keys) {
        for (const word of FORBIDDEN) {
          expect(
            key.includes(word),
            `UiAccessState gained key "${key}" containing "${word}". Billing must never carry a telephony signal — see this file's header and plan §5.`
          ).toBe(false);
        }
      }
    }
  });

  it("returns exactly the four documented keys and nothing more", () => {
    for (const t of everyRung) {
      expect(Object.keys(evaluateBillingAccess(t, NOW)).sort()).toEqual(
        ["bannerText", "graceDaysRemaining", "ownerExempt", "rung"]
      );
    }
  });

  it("never returns a boolean-ish value that reads as 'stop the calls'", () => {
    // ownerExempt is the only boolean, and it means "let the admin IN", not
    // "shut something off". Asserting its polarity here so a future refactor
    // cannot quietly invert it into a kill signal.
    const blocked = evaluateBillingAccess(tenant({ paidUntil: daysFromNow(-30) }), NOW);
    expect(blocked.ownerExempt).toBe(true);
  });

  it("tells the user their calls are unaffected at every rung that shows a banner", () => {
    // The wording matters: this is the distinction the plan asks us to reuse
    // everywhere, and it is what stops a suspended tenant panicking about an
    // outage they do not have.
    const withBanners = [
      tenant({ paidUntil: daysFromNow(-1) }),
      tenant({ paidUntil: daysFromNow(-30) }),
      tenant({ status: "SUSPENDED" }),
    ];
    for (const t of withBanners) {
      expect(evaluateBillingAccess(t, NOW).bannerText).toMatch(/not affected|unaffected/i);
    }
  });
});

describe("evaluateBillingAccess — purity", () => {
  it("defaults `now` to the current time without throwing", () => {
    expect(() => evaluateBillingAccess(tenant())).not.toThrow();
  });

  it("does not mutate its input", () => {
    const input = tenant({ paidUntil: daysFromNow(-30) });
    const snapshot = JSON.stringify(input);
    evaluateBillingAccess(input, NOW);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("is deterministic for the same inputs", () => {
    const input = tenant({ paidUntil: daysFromNow(-3) });
    const a: UiAccessState = evaluateBillingAccess(input, NOW);
    const b: UiAccessState = evaluateBillingAccess(input, NOW);
    expect(a).toEqual(b);
  });
});
