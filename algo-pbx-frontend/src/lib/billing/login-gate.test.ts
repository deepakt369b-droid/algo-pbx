import { describe, it, expect } from "vitest";
import { evaluateLoginGate, loginLandingPath, type TenantRole } from "./login-gate";
import type { BillingTenantView } from "./enforcement";

const NOW = new Date("2026-09-05T12:00:00.000Z");
const daysFromNow = (d: number) => new Date(NOW.getTime() + d * 24 * 60 * 60 * 1000);

function tenant(o: Partial<BillingTenantView> = {}): BillingTenantView {
  return { billingStatus: "ACTIVE", paidUntil: daysFromNow(30), status: "ACTIVE", ...o };
}

const ROLES: TenantRole[] = ["ADMIN", "SUPERVISOR", "AGENT"];

describe("in good standing", () => {
  it.each(ROLES)("lets %s straight in", (role) => {
    const r = evaluateLoginGate(tenant(), role, NOW);
    expect(r).toEqual({ allowed: true, rung: "ok", billingHoldOnly: false });
  });
});

describe("inside the grace window", () => {
  // The banner is the whole enforcement at this rung — nobody is blocked.
  it.each(ROLES)("still lets %s in with full access", (role) => {
    const r = evaluateLoginGate(tenant({ paidUntil: daysFromNow(-3) }), role, NOW);
    expect(r).toEqual({ allowed: true, rung: "warning", billingHoldOnly: false });
  });
});

describe("past the grace window", () => {
  const lapsed = tenant({ paidUntil: daysFromNow(-30), billingStatus: "PAST_DUE" });

  it.each<TenantRole>(["AGENT", "SUPERVISOR"])("blocks %s", (role) => {
    const r = evaluateLoginGate(lapsed, role, NOW);
    expect(r.allowed).toBe(false);
    if (r.allowed) throw new Error("expected blocked");
    expect(r.reason).toMatch(/administrator can sign in/);
  });

  // Locking out the person who can pay would make the ladder self-defeating.
  it("lets the tenant ADMIN in, confined to the billing page", () => {
    const r = evaluateLoginGate(lapsed, "ADMIN", NOW);
    expect(r).toEqual({ allowed: true, rung: "login_blocked", billingHoldOnly: true });
    expect(loginLandingPath(r)).toBe("/billing-hold");
  });
});

describe("suspended and offboarded", () => {
  it("blocks agents on a manually suspended tenant", () => {
    expect(evaluateLoginGate(tenant({ status: "SUSPENDED" }), "AGENT", NOW).allowed).toBe(false);
  });

  it("keeps the admin exemption on a suspended tenant", () => {
    const r = evaluateLoginGate(tenant({ status: "SUSPENDED" }), "ADMIN", NOW);
    expect(r).toMatchObject({ allowed: true, billingHoldOnly: true });
  });

  it("tells an offboarded tenant's users something accurate", () => {
    const r = evaluateLoginGate(tenant({ status: "OFFBOARDED" }), "AGENT", NOW);
    if (r.allowed) throw new Error("expected blocked");
    expect(r.reason).toMatch(/offboarded/i);
  });
});

describe("owner override restores access immediately", () => {
  it("goes from blocked to allowed the moment paidUntil moves", () => {
    const lapsed = tenant({ paidUntil: daysFromNow(-30) });
    expect(evaluateLoginGate(lapsed, "AGENT", NOW).allowed).toBe(false);

    const paid = { ...lapsed, paidUntil: daysFromNow(30) };
    expect(evaluateLoginGate(paid, "AGENT", NOW).allowed).toBe(true);
  });
});

describe("landing path", () => {
  it("does not redirect a normally-allowed session", () => {
    expect(loginLandingPath(evaluateLoginGate(tenant(), "AGENT", NOW))).toBeNull();
  });
});

describe("telephony separation holds through this layer too", () => {
  it("returns no key a telephony caller could act on", () => {
    const cases = [tenant(), tenant({ paidUntil: daysFromNow(-3) }), tenant({ status: "SUSPENDED" })];
    for (const t of cases) {
      for (const role of ROLES) {
        const keys = Object.keys(evaluateLoginGate(t, role, NOW)).map((k) => k.toLowerCase());
        for (const key of keys) {
          expect(/call|telephony|dialplan|pjsip|asterisk|trunk|sip/.test(key)).toBe(false);
        }
      }
    }
  });
});
