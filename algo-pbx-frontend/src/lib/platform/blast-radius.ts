// Confirmation copy for destructive platform actions.
//
// This module exists because the WORDING is a requirement, not decoration.
// Every destructive action's confirmation dialog must restate its blast
// radius, and the suspend/telephony distinction must read identically
// everywhere — an operator who sees "calls are NOT affected" on one screen
// and nothing on the next will eventually assume the second one does cut
// calls, and hesitate at exactly the wrong moment.
//
// Keeping the strings here (and asserting them literally in
// blast-radius.test.ts) means a copy edit in a component cannot silently
// drift the guarantee. If a string below must change, the test changes with
// it, deliberately, in the same commit.
//
// Pure: no DB, no i18n, no formatting locale. Callers pass counts they have
// already fetched.

function pluraliseUsers(n: number): string {
  return `${n} user${n === 1 ? "" : "s"}`;
}

/**
 * Suspend — the UI-access ladder's manual rung. Calls keep flowing; this is
 * the sentence that says so, and it is the canonical phrasing every other
 * billing/lifecycle surface reuses.
 */
export function suspendBlastRadius(tenantName: string, userCount: number): string {
  return `This suspends login for all ${pluraliseUsers(userCount)} of ${tenantName}. Calls are NOT affected.`;
}

export function unsuspendBlastRadius(tenantName: string, userCount: number): string {
  return `This restores login for all ${pluraliseUsers(userCount)} of ${tenantName}. Calls were never affected.`;
}

/**
 * Cut dialplan — the telephony kill switch. The plan is emphatic that this is
 * separate from suspension, manual, owner-only, and reachable by no automatic
 * path. The copy has to be equally emphatic, because it is the one action in
 * this console whose blast radius is a customer-visible outage: their callers
 * hear failure, and their customers blame them.
 */
export function dialplanCutBlastRadius(tenantName: string): string {
  return (
    `This STOPS ALL CALLS for ${tenantName} — inbound and outbound — immediately. ` +
    `Their callers will not get through, and their customers will blame them, not us. ` +
    `This is not a billing action and is never triggered automatically. ` +
    `Type the tenant slug below to confirm you intend a telephony outage.`
  );
}

export function dialplanRestoreBlastRadius(tenantName: string): string {
  return `This restores inbound and outbound calling for ${tenantName}.`;
}

/**
 * Offboard — the end of the relationship. Names what is revoked, and states
 * the plan's unconditional rule that nothing is deleted here, so an operator
 * never believes they have already handled a PDPL deletion request by
 * offboarding.
 */
export function offboardBlastRadius(tenantName: string, userCount: number): string {
  return (
    `This offboards ${tenantName}: their gateway certificate is revoked, the CRL is ` +
    `regenerated, OpenVPN is reloaded, their subnet is blocked at the firewall, and login ` +
    `ends for all ${pluraliseUsers(userCount)}. ` +
    `NO DATA IS DELETED — export must be offered first, and deletion happens only on an ` +
    `explicit customer request (PDPL) or at the end of the stated retention period.`
  );
}

/** Support grant — not destructive, but consequential and visible to the
 * customer, so it gets the same treatment. */
export function supportGrantBlastRadius(tenantName: string, hours: number): string {
  return (
    `This gives you read access to ${tenantName}'s data for ${hours} hour${hours === 1 ? "" : "s"}. ` +
    `They will see a banner naming you and the expiry for as long as it is live, and both ` +
    `their audit log and the platform audit log will record it.`
  );
}

export function platformUserDisableBlastRadius(email: string): string {
  return `This ends ${email}'s access on their very next request. Any support grants they hold stop working.`;
}

export function platformOwnerCreateBlastRadius(email: string): string {
  return (
    `This creates ${email} as a PLATFORM_OWNER — able to provision, suspend, offboard, ` +
    `change billing, and cut any tenant's dialplan. Type the email below to confirm.`
  );
}

/** The recurring one-liner reused wherever a billing surface needs to reassure
 * without a full blast-radius paragraph. Single source so it cannot drift. */
export const TELEPHONY_UNAFFECTED_NOTE =
  "Billing enforcement affects web login only. Calls are never stopped automatically — inbound or outbound.";
