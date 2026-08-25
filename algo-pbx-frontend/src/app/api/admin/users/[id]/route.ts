import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireStaffSession } from "@/lib/auth-guard";
import { maybeCompleteProfile } from "@/lib/registration";
import { getAmiClient } from "@/lib/ami-client";
import { addQueueMember, removeQueueMember } from "@/lib/queue-membership";

export const dynamic = "force-dynamic";

// PATCH /api/admin/users/[id] — toggles User.disabled (account
// revocation) and, new here, overrides phone verification. Deliberately
// does NOT accept email or password fields — those stay admin-set-once
// (email at creation) or agent-set-once (password via the invite flow).
const PatchSchema = z.union([
  z.object({ disabled: z.boolean() }),
  // Admin override for the "OTP delivery is having a glitch" case named
  // explicitly in the plan: an admin can mark a number verified without
  // an OTP round-trip. This is intentionally a WEAKER claim than
  // self-verification, and stays visibly distinguishable —
  // phoneVerifiedByAdminId is set (never null) on this path, vs. null
  // for a real Firebase/WhatsApp verification. An auditor reading the
  // User row (or the AuditLog entry this writes) can always tell an
  // override from a real verification.
  z.object({ verifyPhoneOverride: z.literal(true) }),
]);

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const target = await db.user.findUnique({ where: { id: params.id }, include: { extension: true } });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Same escalation guard as user creation: a SUPERVISOR may not act on a
  // SUPERVISOR/ADMIN account, only AGENT accounts.
  if (target.role !== "AGENT" && guard.session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Only ADMIN may modify SUPERVISOR or ADMIN accounts." }, { status: 403 });
  }

  if ("disabled" in parsed.data) {
    if (target.id === guard.session.user.id && parsed.data.disabled) {
      return NextResponse.json({ error: "You cannot disable your own account." }, { status: 400 });
    }

    const updated = await db.user.update({
      where: { id: target.id },
      data: { disabled: parsed.data.disabled, disabledAt: parsed.data.disabled ? new Date() : null },
    });

    await db.auditLog.create({
      data: {
        action: parsed.data.disabled ? "user.disable" : "user.enable",
        actorId: guard.session.user.id,
        targetId: target.id,
        metadata: { email: target.email },
      },
    });

    // Keep queue membership in sync — a disabled agent must stop
    // receiving calls immediately, and a re-enabled one should start
    // again without a separate manual step.
    let queueWarning: string | undefined;
    if (target.extension) {
      try {
        if (parsed.data.disabled) await removeQueueMember(getAmiClient(), target.extension.number);
        else await addQueueMember(getAmiClient(), target.extension.number);
      } catch (err) {
        queueWarning = `Account ${parsed.data.disabled ? "disabled" : "enabled"}, but updating queue membership failed: ${err instanceof Error ? err.message : "unknown error"}.`;
      }
    }

    return NextResponse.json({
      user: { id: updated.id, email: updated.email, disabled: updated.disabled },
      warning: queueWarning,
    });
  }

  // verifyPhoneOverride
  if (!target.phoneE164) {
    return NextResponse.json({ error: "This user has not submitted a contact number yet — nothing to verify." }, { status: 409 });
  }

  const updated = await db.user.update({
    where: { id: target.id },
    data: { phoneVerifiedAt: new Date(), phoneVerifiedByAdminId: guard.session.user.id },
  });

  await db.auditLog.create({
    data: {
      action: "user.phone_verified_by_admin",
      actorId: guard.session.user.id,
      targetId: target.id,
      metadata: { email: target.email, phoneE164: target.phoneE164 },
    },
  });

  await maybeCompleteProfile(target.id);

  return NextResponse.json({
    user: { id: updated.id, email: updated.email, phoneVerifiedAt: updated.phoneVerifiedAt, phoneVerifiedByAdminId: updated.phoneVerifiedByAdminId },
  });
}
