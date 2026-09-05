// The billing enforcement ladder (approved plan §5 / Requirement B).
//
// ============================================================================
// READ THIS BEFORE CHANGING ANYTHING IN THIS FILE
// ============================================================================
// This function decides ONE thing: whether a tenant's users may log into the
// WEB UI. It has no opinion about telephony, and it must never acquire one.
//
// The plan states the rule and the reasoning verbatim:
//
//   "Every rung above governs UI login and nothing else. Asterisk keeps
//    carrying that tenant's calls, inbound AND outbound, through every rung
//    of the ladder. ... A tenant whose calls stop on day 8 of a *disputed*
//    invoice does not experience an enforcement lever — they experience an
//    outage, and THEIR customers blame THEM, not us. That is a churn event on
//    the spot, and it is business-destroying damage dressed up as policy.
//    Inbound calls in particular should never stop automatically at all."
//
//   "The enforcement function must reflect this in its type: it returns a UI
//    access state, and has no telephony-affecting return value at all. That
//    way the separation is structural rather than remembered."
//
// So: `UiAccessState` below deliberately contains no field that any dialplan
// generator, PJSIP provisioner, or AMI caller could act on. That omission is
// the safety mechanism. Adding a `suspendCalls`, `blockOutbound`, or similar
// field here would silently create the automatic path to a telephony cut that
// the plan forbids — cutting a tenant's dialplan is a SEPARATE, manual,
// owner-only action with its own typed confirmation, living in
// POST /api/platform/tenants/[id]/dialplan-cut and reachable from nowhere
// else.
//
// A CI invariant backs this up: no file under src/lib/dinstar/, pjsip-*,
// ami-client, or any dialplan generator may import this module.
// ============================================================================

/** How far along the ladder this tenant is, for UI login purposes only. */
export type BillingRung = "ok" | "warning" | "login_blocked";

export interface UiAccessState {
  rung: BillingRung;
  /** Whole days left in the 7-day grace window at `warning`; null otherwise.
   * Floors toward zero, so "0 days left" means the block lands today. */
  graceDaysRemaining: number | null;
  /** At `login_blocked`, the tenant's own ADMIN may still sign in and sees
   * only a billing/contact page — so they can actually pay us. Always false
   * at other rungs, where nobody is blocked in the first place. */
  ownerExempt: boolean;
  /** Copy for the in-app banner, or null when there is nothing to say. */
  bannerText: string | null;
}

export interface BillingTenantView {
  billingStatus: "TRIAL" | "ACTIVE" | "PAST_DUE" | "SUSPENDED";
  paidUntil: Date | null;
  status: "TRIAL" | "ACTIVE" | "SUSPENDED" | "OFFBOARDED";
}

/** The plan's rung 1: "paidUntil lapses → 7-day in-app warning banner, full
 * access retained." Exported so the tests and the UI agree on the number. */
export const GRACE_PERIOD_DAYS = 7;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days elapsed since `from`, floored. Negative when `from` is in the
 * future (i.e. the tenant is paid up). */
function daysSince(from: Date, now: Date): number {
  return Math.floor((now.getTime() - from.getTime()) / MS_PER_DAY);
}

/**
 * Decides whether this tenant's users may log into the web UI.
 *
 * Pure: no DB, no clock, no env — `now` is injected so every rung is
 * directly testable, the same convention `recording-access.ts` and
 * `queue-status.ts` already use for decision logic this repo cannot
 * integration-test.
 *
 * Never returns anything a caller could use to affect calls. See the header.
 */
export function evaluateBillingAccess(
  tenant: BillingTenantView,
  now: Date = new Date()
): UiAccessState {
  // An offboarded tenant is finished, regardless of what its billing fields
  // say — the lifecycle action already ran and wrote its audit entry. Note
  // this still only blocks LOGIN; offboarding's telephony and cert steps are
  // explicit actions in the offboard route, not consequences of this value.
  if (tenant.status === "OFFBOARDED") {
    return {
      rung: "login_blocked",
      graceDaysRemaining: null,
      ownerExempt: true,
      bannerText: "This workspace has been offboarded. Contact Algo PBX to discuss data export.",
    };
  }

  // A manual owner suspension short-circuits the date arithmetic entirely:
  // the owner said "blocked", so it is blocked, and no amount of paidUntil in
  // the future overrides an explicit decision someone made on purpose.
  if (tenant.status === "SUSPENDED" || tenant.billingStatus === "SUSPENDED") {
    return {
      rung: "login_blocked",
      graceDaysRemaining: null,
      ownerExempt: true,
      bannerText: "This workspace is suspended. Calls are unaffected. Contact Algo PBX to restore access.",
    };
  }

  // No paidUntil set at all = a trial or a comped tenant that nobody has put
  // a date on. Deliberately permissive: this function's job is to enforce a
  // date that has passed, and there is no such date here. Locking out a
  // tenant because a bookkeeping field was left blank would be an outage we
  // caused, which is the exact failure mode this whole section exists to
  // avoid.
  if (tenant.paidUntil === null) {
    return { rung: "ok", graceDaysRemaining: null, ownerExempt: false, bannerText: null };
  }

  const daysOverdue = daysSince(tenant.paidUntil, now);

  // Still paid up (daysOverdue < 0), or lapsed less than a full day ago.
  if (daysOverdue < 0) {
    return { rung: "ok", graceDaysRemaining: null, ownerExempt: false, bannerText: null };
  }

  // Rung 1 — lapsed, inside the 7-day grace window. Full access retained;
  // the banner is the entire enforcement at this rung.
  if (daysOverdue < GRACE_PERIOD_DAYS) {
    const graceDaysRemaining = GRACE_PERIOD_DAYS - daysOverdue;
    return {
      rung: "warning",
      graceDaysRemaining,
      ownerExempt: false,
      bannerText:
        `Payment is overdue. Access to this workspace will be limited in ${graceDaysRemaining} ` +
        `day${graceDaysRemaining === 1 ? "" : "s"}. Your calls are not affected.`,
    };
  }

  // Rung 2 — past the grace window. Login blocked, except the tenant's own
  // ADMIN, who lands on the billing-hold page so they can settle up.
  return {
    rung: "login_blocked",
    graceDaysRemaining: 0,
    ownerExempt: true,
    bannerText: "Payment is overdue and access is limited. Your calls are not affected.",
  };
}
