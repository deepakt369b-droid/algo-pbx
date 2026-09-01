// Feature S2b (2026-09-01) — the deal-side mirror of contact-ownership.ts's
// canWriteContact. Agents only work their own pipeline deals; SUPERVISOR/
// ADMIN can always write (oversight), matching the same convention applied
// across auth-guard.ts (requireStaffSession vs requireSession). Pure
// function, no Prisma import, so it is unit-testable without a database.
//
// Note: unlike a contact, a Deal.ownerId is NOT nullable in the schema —
// every deal always has an owner — so there is no "unowned, anyone may
// claim it" branch here.

export type DealOwnershipRole = "AGENT" | "SUPERVISOR" | "ADMIN";

export function canWriteDeal({
  role,
  userId,
  ownerId,
}: {
  role: DealOwnershipRole;
  userId: string;
  ownerId: string | null;
}): boolean {
  if (role === "SUPERVISOR" || role === "ADMIN") return true;
  if (ownerId === null) return true;
  return ownerId === userId;
}
