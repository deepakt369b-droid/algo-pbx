// Whether a tenant user may complete a login, given their tenant's billing
// state. The pure half of the enforcement ladder's actual teeth.
//
// Separated from evaluateBillingAccess() because the two answer different
// questions: that one returns the tenant's LADDER STATE (used to render
// banners and the console's billing tab); this one turns that state plus a
// specific user's role into an allow/deny for one login attempt.
//
// The tenant-ADMIN exemption is the important part. Plan §5 rung 2: "tenant
// login blocked, except the tenant OWNER, who can still log in and sees only
// a billing/contact page." Locking out the very person who can pay the
// invoice would make the ladder self-defeating — it would remove the ability
// to resolve the thing being enforced.
//
// As everywhere in this feature: this decides UI LOGIN ONLY. It has no
// telephony effect and returns nothing a telephony caller could act on.

import { evaluateBillingAccess, type BillingTenantView, type BillingRung } from "./enforcement";

export type TenantRole = "ADMIN" | "SUPERVISOR" | "AGENT";

export type LoginGateResult =
  | { allowed: true; rung: BillingRung; billingHoldOnly: false }
  /** The tenant admin, allowed in but confined to the billing page. */
  | { allowed: true; rung: BillingRung; billingHoldOnly: true }
  | { allowed: false; rung: BillingRung; reason: string };

export function evaluateLoginGate(
  tenant: BillingTenantView,
  role: TenantRole,
  now: Date = new Date()
): LoginGateResult {
  const access = evaluateBillingAccess(tenant, now);

  if (access.rung !== "login_blocked") {
    // "warning" retains full access by design — the banner is the entire
    // enforcement at that rung.
    return { allowed: true, rung: access.rung, billingHoldOnly: false };
  }

  if (role === "ADMIN") {
    return { allowed: true, rung: access.rung, billingHoldOnly: true };
  }

  return {
    allowed: false,
    rung: access.rung,
    reason:
      tenant.status === "OFFBOARDED"
        ? "This workspace has been offboarded."
        : "This workspace's access is limited pending payment. Your administrator can sign in to resolve it.",
  };
}

/** Where a session that got in should land. `null` means "wherever they were
 * going" — the caller does not redirect. */
export function loginLandingPath(result: LoginGateResult): string | null {
  if (result.allowed && result.billingHoldOnly) return "/billing-hold";
  return null;
}
