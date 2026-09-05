import type { Prisma } from "@prisma/client";
import { unsafeGlobalDb as db } from "@/lib/db";

// Time-boxed, reasoned, dual-logged support access (plan §3). A live row
// here is the ONLY thing that lets a PLATFORM_SUPPORT (or an OWNER reading
// tenant content, per plan §3's "OWNER cannot read tenant call content by
// default" clause) actually see a tenant's data. Absence of a live grant
// means nothing — this module intentionally does not hand out a
// tenant-scoped Prisma client itself (that's wave 2a's tenantDb); a later
// wave wires "does a live grant exist for this session+tenant" into
// whatever scoped-access mechanism it builds.

const MIN_DURATION_MINUTES = 5;
// Hard ceiling — plan §"SupportGrant": "no open-ended grants". 24h is
// generous enough for a full investigation without ever being able to
// silently become permanent.
const MAX_DURATION_MINUTES = 24 * 60;

export interface CreateSupportGrantInput {
  tenantId: string;
  platformUserId: string;
  reason: string;
  durationMinutes: number;
}

export interface SupportGrantRecord {
  id: string;
  tenantId: string;
  platformUserId: string;
  reason: string;
  grantedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

/** Pure and unit-tested separately from the DB round trip below: is this
 * grant live RIGHT NOW? A grant is live iff it hasn't been revoked and its
 * hard expiry hasn't passed — no other state. */
export function isGrantLive(
  grant: Pick<SupportGrantRecord, "expiresAt" | "revokedAt">,
  now: Date = new Date()
): boolean {
  if (grant.revokedAt !== null) return false;
  return grant.expiresAt.getTime() > now.getTime();
}

/** Clamps a requested grant duration into [MIN_DURATION_MINUTES,
 * MAX_DURATION_MINUTES], flooring to a whole minute. Exported so the
 * boundary behaviour (including non-finite/negative input) is unit-tested
 * without a database. */
export function clampSupportGrantDuration(requestedMinutes: number): number {
  if (!Number.isFinite(requestedMinutes)) return MIN_DURATION_MINUTES;
  const floored = Math.floor(requestedMinutes);
  return Math.min(Math.max(floored, MIN_DURATION_MINUTES), MAX_DURATION_MINUTES);
}

/** Deterministic per-tenant "system" User row that exists ONLY to be the
 * FK target for a tenant AuditLog entry recording platform-support access.
 *
 * The friction this works around: AuditLog.actorId is a required FK to
 * User (prisma/schema.prisma's own comment on AuditLog explains why — it
 * predates the platform plane and every actor used to be a tenant user).
 * A PlatformUser is NOT a User and never will be (D2: that's the entire
 * point of the separate table) — so there is no real row to point
 * actorId at.
 *
 * Considered and rejected:
 *   - Making AuditLog.actorId nullable / adding a second optional
 *     `platformActorId` FK. Correct long-term, but it's a schema change to
 *     a table wave 1 just finished migrating, touching every one of the
 *     ~40 existing `db.auditLog.create()` call sites' types, and it's out
 *     of this wave's file scope (schema.prisma is contended with wave 2a
 *     already in flight in a different worktree).
 *   - Skipping the tenant-side write entirely and relying on
 *     PlatformAuditLog alone. Rejected outright — it's the literal opposite
 *     of the plan's "the tenant can see we entered" requirement.
 *
 * This function's answer: one disabled, passwordless User row per tenant,
 * created lazily on first use, whose sole purpose is to be a legible
 * actorId. It can never log in (passwordHash null is already this schema's
 * documented "credentials can never match" state, and disabled: true is
 * redundant belt-and-braces on top of that). Its name is deliberately
 * loud ("do not use") so it reads as what it is if an admin ever notices
 * it in a user list. The REAL identity of who did this is never lost — it
 * lives in AuditLog.metadata.platformUserId/reason on the very same row,
 * and in full in PlatformAuditLog. Tradeoff accepted: this row will show
 * up in any UI that lists ALL of a tenant's User rows unfiltered (e.g. a
 * future admin "manage users" page that doesn't already filter by role);
 * no such filtering is added here since it's out of this wave's scope
 * (constraints: no admin-side file edits) — flagged here for whoever
 * builds or audits that page next.
 */
function systemActorEmail(tenantId: string): string {
  return `platform-support-system+${tenantId}@algopbx.internal`;
}

/** Upserts (and returns the id of) the per-tenant system actor described
 * above.
 *
 * Exported because the owner console hit the identical wall: any platform
 * action that writes a TENANT-side AuditLog row — creating a grant, or
 * pushing a VPN config through the existing tenant-scoped helper — needs an
 * actorId that is a real User, and a PlatformUser is deliberately not one.
 * Sharing this function rather than re-deriving the email string elsewhere
 * keeps there being exactly ONE such row per tenant; two call sites inventing
 * their own convention would quietly create two "do not use" accounts in the
 * customer's user directory.
 */
export async function ensureSystemActorId(
  // Prisma's own transaction-client type, so both a `$transaction` callback's
  // `tx` and the global client satisfy it without a hand-rolled structural
  // type that would have to track Prisma's generated argument shapes.
  tx: Pick<Prisma.TransactionClient, "user">,
  tenantId: string
): Promise<string> {
  const actor = await tx.user.upsert({
    where: { email: systemActorEmail(tenantId) },
    update: {},
    create: {
      tenantId,
      email: systemActorEmail(tenantId),
      name: "Platform Support (system account — do not use)",
      role: "ADMIN",
      passwordHash: null,
      disabled: true,
      disabledAt: new Date(),
    },
  });
  return actor.id;
}

export async function createSupportGrant(input: CreateSupportGrantInput): Promise<SupportGrantRecord> {
  const reason = input.reason.trim();
  if (!reason) {
    // Mandatory reason, rejected here (not just at the form) — plan
    // §1/§5: "reason mandatory for every destructive/consequential
    // platform action", and a support grant into a tenant's live data is
    // squarely one of those.
    throw new Error("A non-empty reason is required to create a support grant.");
  }
  const durationMinutes = clampSupportGrantDuration(input.durationMinutes);
  const expiresAt = new Date(Date.now() + durationMinutes * 60_000);

  return db.$transaction(async (tx) => {
    const systemActorId = await ensureSystemActorId(tx, input.tenantId);

    const grant = await tx.supportGrant.create({
      data: {
        tenantId: input.tenantId,
        platformUserId: input.platformUserId,
        reason,
        expiresAt,
      },
    });

    // Dual-write, same logical operation (plan §3's whole point). Both
    // writes happen inside this one transaction so a failure on either
    // side rolls back the grant itself too — a grant that exists in only
    // one of the two audit trails is worse than no grant at all.
    await tx.platformAuditLog.create({
      data: {
        action: "support_grant.create",
        platformUserId: input.platformUserId,
        tenantId: input.tenantId,
        reason,
        metadata: { supportGrantId: grant.id, expiresAt: expiresAt.toISOString(), durationMinutes },
      },
    });

    await tx.auditLog.create({
      data: {
        tenantId: input.tenantId,
        action: "support_grant.create",
        actorId: systemActorId,
        targetId: grant.id,
        metadata: {
          platformUserId: input.platformUserId,
          reason,
          expiresAt: expiresAt.toISOString(),
          note: "Real actor is a platform-plane account, not this tenant's user directory — see PlatformAuditLog for identity.",
        },
      },
    });

    return grant;
  });
}

export async function getActiveGrant(platformUserId: string, tenantId: string): Promise<SupportGrantRecord | null> {
  return db.supportGrant.findFirst({
    where: { platformUserId, tenantId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { grantedAt: "desc" },
  });
}

/** For the tenant-facing banner (src/components/support-access-banner.tsx):
 * any live grant against this tenant, regardless of which platform user
 * holds it, plus enough of that user's identity to name them in the
 * banner. */
export async function getActiveGrantForTenant(tenantId: string): Promise<
  (SupportGrantRecord & { platformUser: { name: string; email: string } }) | null
> {
  return db.supportGrant.findFirst({
    where: { tenantId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { grantedAt: "desc" },
    include: { platformUser: { select: { name: true, email: true } } },
  });
}

export async function revokeGrant(grantId: string, revokedByPlatformUserId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const grant = await tx.supportGrant.update({
      where: { id: grantId },
      data: { revokedAt: new Date() },
    });

    await tx.platformAuditLog.create({
      data: {
        action: "support_grant.revoke",
        platformUserId: revokedByPlatformUserId,
        tenantId: grant.tenantId,
        metadata: { supportGrantId: grant.id },
      },
    });

    // Symmetric visibility with creation: the tenant saw us enter, so the
    // tenant should be able to see us leave too. Best-effort — if the
    // system actor row somehow doesn't exist yet (it always should, since
    // creation always upserts one first), the revoke itself still
    // succeeds; only this one extra tenant-visible line is skipped.
    const systemActor = await tx.user.findUnique({ where: { email: systemActorEmail(grant.tenantId) } });
    if (systemActor) {
      await tx.auditLog.create({
        data: {
          tenantId: grant.tenantId,
          action: "support_grant.revoke",
          actorId: systemActor.id,
          targetId: grant.id,
          metadata: { revokedByPlatformUserId },
        },
      });
    }
  });
}
