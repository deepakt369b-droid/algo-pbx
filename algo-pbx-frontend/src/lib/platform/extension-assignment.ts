// Pure decision logic for the owner console's extension-assignment action
// (tenant management modal, W1). Kept DB-free so the PATCH route
// (src/app/api/platform/tenants/[id]/extensions/[extensionId]/route.ts) can
// stay thin: fetch the rows, call this, act on the verdict.
//
// The one rule this enforces: `Extension.userId` is `@unique` in the schema
// (one user holds at most one extension), so assigning an extension to a
// user who already holds a different one must be rejected with a readable
// message rather than surfacing as an opaque unique-constraint 500.

export interface AssignExtensionInput {
  extensionTenantId: string;
  userTenantId: string;
  /** The id of the extension the target user currently holds, if any
   * (distinct from the extension being assigned). */
  userExistingExtensionId: string | null;
  /** The id of the extension being assigned — excluded from the "already
   * holds one" check so re-assigning a user to their own extension is a
   * no-op, not a conflict. */
  targetExtensionId: string;
}

export type AssignExtensionVerdict = { ok: true } | { ok: false; error: string };

export function canAssignExtension(input: AssignExtensionInput): AssignExtensionVerdict {
  if (input.extensionTenantId !== input.userTenantId) {
    return { ok: false, error: "The user and the extension must belong to the same tenant." };
  }
  if (input.userExistingExtensionId && input.userExistingExtensionId !== input.targetExtensionId) {
    return {
      ok: false,
      error: "This user already holds a different extension. Unassign it first.",
    };
  }
  return { ok: true };
}

export interface UnassignExtensionInput {
  /** Whether the extension currently has an assigned user at all. */
  hasAssignedUser: boolean;
}

export function canUnassignExtension(input: UnassignExtensionInput): AssignExtensionVerdict {
  if (!input.hasAssignedUser) {
    return { ok: false, error: "This extension has no assigned user to remove." };
  }
  return { ok: true };
}
