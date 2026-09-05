// Guardrails on platform-user management.
//
// Two rules, both of which exist to prevent an irrecoverable state rather
// than to express a policy preference:
//
//   1. The last enabled PLATFORM_OWNER can never be disabled or demoted.
//      Owner is the only role that can create or promote another owner, so
//      losing the last one locks everybody out of provisioning, billing and
//      offboarding permanently — recoverable only by running
//      scripts/create-platform-user.mjs on the production host with shell
//      access. That is a real outage caused by one careless click.
//
//   2. Nobody may edit their own role. Self-promotion turns a compromised
//      PLATFORM_SUPPORT session into a PLATFORM_OWNER one, which is the whole
//      privilege boundary this plane exists to draw. Self-demotion is blocked
//      by the same check, which is a harmless side effect and also avoids
//      rule 1's last-owner case arriving by a second route.
//
// Pure and injected: the caller fetches the current user set and passes it
// in, so this is unit-testable without a database and returns a refusal
// REASON that the API can surface verbatim rather than a bare boolean.

export type PlatformRole = "PLATFORM_OWNER" | "PLATFORM_SUPPORT";

export interface PlatformUserView {
  id: string;
  email: string;
  role: PlatformRole;
  disabled: boolean;
}

export type GuardrailResult = { ok: true } | { ok: false; refused: true; reason: string };

const ok: GuardrailResult = { ok: true };
function refuse(reason: string): GuardrailResult {
  return { ok: false, refused: true, reason };
}

/** Enabled owners other than `excludingId`. The "enabled" part matters: a
 * disabled owner cannot log in, so it cannot be the account that rescues us. */
function otherEnabledOwners(all: readonly PlatformUserView[], excludingId: string): PlatformUserView[] {
  return all.filter((u) => u.id !== excludingId && u.role === "PLATFORM_OWNER" && !u.disabled);
}

export function canDisable(
  target: PlatformUserView,
  all: readonly PlatformUserView[],
  actorId: string
): GuardrailResult {
  if (target.disabled) return refuse(`${target.email} is already disabled.`);

  // Self-disable is not a last-owner problem specifically, but it is the same
  // class of foot-gun and there is never a good reason for it — an operator
  // wanting to leave asks another owner to disable them.
  if (target.id === actorId) {
    return refuse("You cannot disable your own account. Ask another platform owner to do it.");
  }

  if (target.role === "PLATFORM_OWNER" && otherEnabledOwners(all, target.id).length === 0) {
    return refuse(
      `${target.email} is the last enabled PLATFORM_OWNER. Disabling them would leave nobody able ` +
        `to provision, bill, or offboard — recoverable only with shell access to the production host. ` +
        `Create another owner first.`
    );
  }

  return ok;
}

export function canEnable(target: PlatformUserView): GuardrailResult {
  if (!target.disabled) return refuse(`${target.email} is already enabled.`);
  return ok;
}

export function canChangeRole(
  target: PlatformUserView,
  nextRole: PlatformRole,
  all: readonly PlatformUserView[],
  actorId: string
): GuardrailResult {
  if (target.id === actorId) {
    return refuse("You cannot change your own role. Ask another platform owner to do it.");
  }

  if (target.role === nextRole) {
    return refuse(`${target.email} already has the ${nextRole} role.`);
  }

  // The demotion half of rule 1. Note this is checked on the target's CURRENT
  // role, so promoting a support user is always fine.
  if (target.role === "PLATFORM_OWNER" && otherEnabledOwners(all, target.id).length === 0) {
    return refuse(
      `${target.email} is the last enabled PLATFORM_OWNER. Demoting them would leave nobody able ` +
        `to provision, bill, or offboard. Promote another owner first.`
    );
  }

  return ok;
}

/** TOTP reset is deliberately NOT last-owner-guarded: it does not remove the
 * account's ability to act, it forces re-enrolment on next login. It is in
 * fact the recovery path for an owner who lost their authenticator, so
 * blocking it for the last owner would create the very lockout the other
 * rules prevent. Reason and audit are still mandatory. */
export function canResetTotp(target: PlatformUserView): GuardrailResult {
  if (target.disabled) {
    return refuse(`${target.email} is disabled. Enable the account before resetting TOTP.`);
  }
  return ok;
}

/** Count of enabled owners — used by the UI to explain WHY a control is
 * disabled before the operator clicks it. */
export function enabledOwnerCount(all: readonly PlatformUserView[]): number {
  return all.filter((u) => u.role === "PLATFORM_OWNER" && !u.disabled).length;
}
