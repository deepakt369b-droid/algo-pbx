// Platform-plane audit writing, and the mandatory-reason rule.
//
// The plan makes the reason requirement broad and explicit: "each writing a
// PlatformAuditLog row with a mandatory, non-empty reason (rejected at the
// API layer, not just the form)" and "The same mandatory-reason rule extends
// to EVERY destructive platform action, not billing alone — suspend,
// offboard, cut dialplan, and create support grant."
//
// `requireReason()` is therefore the single chokepoint every consequential
// route calls, so the rule is enforced once and inherited rather than
// re-implemented (and eventually forgotten) per route. `support-grant.ts`
// already does its own equivalent trim-check internally; that stays as-is —
// defence in depth on the one action that reaches into customer data.

import type { Prisma } from "@prisma/client";
import { unsafeGlobalDb as db } from "@/lib/db";

/**
 * Every action string this console may write. A union rather than free text
 * so the audit viewer's filter dropdown is exhaustive by construction and a
 * typo'd action can never quietly become an unfilterable row.
 *
 * `PlatformAuditLog.action` stays a plain String column — the constraint is
 * expressed in TypeScript, not SQL, so adding an action needs no migration.
 */
export type PlatformAuditAction =
  // tenant lifecycle
  | "tenant.provision"
  | "tenant.suspend"
  | "tenant.unsuspend"
  | "tenant.offboard"
  | "tenant.dialplan_cut"
  | "tenant.dialplan_restore"
  | "tenant.compliance_update"
  // billing (UI-access only — none of these touch telephony)
  | "billing.mark_paid"
  | "billing.extend"
  | "billing.change_plan"
  | "billing.comp"
  // platform users
  | "platform_user.create"
  | "platform_user.disable"
  | "platform_user.enable"
  | "platform_user.role_change"
  | "platform_user.totp_reset"
  | "platform_user.password_change"
  | "platform_user.totp_confirmed"
  | "platform.login"
  // support access
  | "support_grant.create"
  | "support_grant.revoke"
  // gateway / connectivity
  | "gateway.push_vpn_config"
  | "gateway.cert_generate"
  // provisioning pipeline
  | "provisioning.step"
  | "provisioning.blocked"
  // settings & exports
  | "settings.update"
  | "audit.export"
  | "recording_target.update";

/** Actions that may never proceed without a non-empty reason. Everything
 * consequential is on this list; the passive ones (login, totp_confirmed)
 * are not, because there is no decision for an operator to justify. */
export const REASON_REQUIRED_ACTIONS: readonly PlatformAuditAction[] = [
  "tenant.provision",
  "tenant.suspend",
  "tenant.unsuspend",
  "tenant.offboard",
  "tenant.dialplan_cut",
  "tenant.dialplan_restore",
  "billing.mark_paid",
  "billing.extend",
  "billing.change_plan",
  "billing.comp",
  "platform_user.create",
  "platform_user.disable",
  "platform_user.enable",
  "platform_user.role_change",
  "platform_user.totp_reset",
  "support_grant.create",
  "support_grant.revoke",
  "settings.update",
  "recording_target.update",
];

export class MissingReasonError extends Error {
  constructor(action?: string) {
    super(
      action
        ? `A non-empty reason is required for "${action}".`
        : "A non-empty reason is required for this action."
    );
    this.name = "MissingReasonError";
  }
}

/**
 * Validates and normalises an operator-supplied reason.
 *
 * Rejects whitespace-only input, not merely the empty string — a reason of
 * " " satisfies a zod `.min(1)` but is exactly as useless to the person
 * reading the audit trail during an incident six months from now. Returns the
 * trimmed value so callers persist the normalised form.
 */
export function requireReason(reason: unknown, action?: string): string {
  if (typeof reason !== "string") throw new MissingReasonError(action);
  const trimmed = reason.trim();
  if (!trimmed) throw new MissingReasonError(action);
  return trimmed;
}

/** Whether this action may proceed without a reason. */
export function isReasonRequired(action: PlatformAuditAction): boolean {
  return REASON_REQUIRED_ACTIONS.includes(action);
}

export interface RecordPlatformAuditInput {
  action: PlatformAuditAction;
  platformUserId?: string | null;
  tenantId?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Writes one platform-plane audit row, enforcing the reason rule for actions
 * that need one.
 *
 * Deliberately awaited by callers rather than fired into the background: an
 * audit row that silently fails to write is worse than an action that fails
 * loudly, and for destructive actions the write belongs in the same
 * transaction as the change itself (pass `tx` for that — see
 * `support-grant.ts` for the pattern this mirrors).
 */
/** Just the slice of a Prisma client this function needs.
 *
 * `create` is declared with METHOD syntax on purpose: TypeScript checks
 * method parameters bivariantly, so the real (far more specific) Prisma
 * delegate AND a test double holding a single spy both satisfy this — which a
 * `create: (args) => ...` property signature would not, under
 * strictFunctionTypes. Keeping the surface this narrow is what lets
 * `recordPlatformAudit` be unit-tested without a database while still
 * accepting a live `$transaction` callback's `tx`. */
export interface PlatformAuditWriter {
  platformAuditLog: {
    create(args: { data: PlatformAuditRow }): Promise<unknown>;
  };
}

interface PlatformAuditRow {
  action: string;
  platformUserId: string | null;
  tenantId: string | null;
  reason: string | null;
  metadata: Prisma.InputJsonValue;
}

export async function recordPlatformAudit(
  input: RecordPlatformAuditInput,
  tx: PlatformAuditWriter = db
): Promise<void> {
  const reason = isReasonRequired(input.action)
    ? requireReason(input.reason, input.action)
    : input.reason?.trim() || null;

  await tx.platformAuditLog.create({
    data: {
      action: input.action,
      platformUserId: input.platformUserId ?? null,
      tenantId: input.tenantId ?? null,
      reason,
      metadata: (input.metadata ?? {}) as Prisma.InputJsonValue,
    },
  });
}
