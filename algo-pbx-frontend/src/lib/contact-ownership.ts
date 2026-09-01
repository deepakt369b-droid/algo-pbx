// Feature B2 (2026-08-31) — the server-side half of "two agents must never
// work the same contact." The client (contact-detail.tsx) hides the write
// UI for a non-owner, but that alone is never enough — every write route
// under /api/agent/crm/contacts/[id]/** must independently refuse a write
// from a non-owner on an OWNED contact, or the guard is cosmetic. Extracted
// as a pure function (no Prisma import) so it's unit-testable without a
// database, same reasoning as canAccessConversation/canSendOnConversation
// in src/lib/messaging/conversation-access.ts, whose shape this mirrors.

export type ContactOwnershipRole = "AGENT" | "SUPERVISOR" | "ADMIN";

/**
 * Whether `userId` (with `role`) may write to a contact currently owned by
 * `ownerId` (null = unowned, anyone may write and thereby claim it via the
 * normal write path). SUPERVISOR/ADMIN can always write — an owned contact
 * blocks OTHER AGENTS, not staff oversight — matching this codebase's
 * existing convention that a manager can always see/act on what an agent
 * sees (e.g. requireStaffSession vs requireSession throughout auth-guard.ts).
 */
export function canWriteContact({
  role,
  userId,
  ownerId,
}: {
  role: ContactOwnershipRole;
  userId: string;
  ownerId: string | null;
}): boolean {
  if (role === "SUPERVISOR" || role === "ADMIN") return true;
  if (ownerId === null) return true;
  return ownerId === userId;
}
