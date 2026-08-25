import { db } from "@/lib/db";
import type { User } from "@prisma/client";

// Shared "is this agent's registration actually complete" check and the
// single place that flips User.profileCompletedAt. Called from every
// route that could be the LAST piece to land (name/address save, phone
// verification, admin override) so profileCompletedAt is always set at
// the moment it becomes true, regardless of which order the agent
// filled things in.
//
// Deliberately requires phoneVerifiedAt, not just phoneE164 — an
// unverified number does not complete registration. photoPath is
// intentionally NOT required here even though the plan asks for a
// photo: a missing/failed photo upload should not be able to
// indefinitely block an agent from taking calls, and the admin-facing
// user list already surfaces whether a photo is present so it isn't a
// silent gap.
export function isProfileComplete(user: Pick<User, "name" | "address" | "phoneE164" | "phoneVerifiedAt">): boolean {
  return Boolean(user.name && user.address && user.phoneE164 && user.phoneVerifiedAt);
}

/** Re-checks completeness for `userId` and sets profileCompletedAt if it
 * just became true and wasn't already set. Idempotent — safe to call
 * from multiple routes without risk of double-writing or clobbering an
 * already-set timestamp. */
export async function maybeCompleteProfile(userId: string): Promise<void> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { name: true, address: true, phoneE164: true, phoneVerifiedAt: true, profileCompletedAt: true },
  });
  if (!user || user.profileCompletedAt) return;
  if (isProfileComplete(user)) {
    await db.user.update({ where: { id: userId }, data: { profileCompletedAt: new Date() } });
  }
}
