import { randomBytes, createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireStaffSession } from "@/lib/auth-guard";
import { maybeCompleteProfile } from "@/lib/registration";
import { getAmiClient } from "@/lib/ami-client";
import { addQueueMember, removeQueueMember } from "@/lib/queue-membership";
import { regeneratePjsipConfigAndReload } from "@/lib/pjsip-provision";
import { sendPasswordResetEmail } from "@/lib/mail/resend";

export const dynamic = "force-dynamic";

const RESET_LINK_TTL_MS = 24 * 60 * 60 * 1000;

// PATCH /api/admin/users/[id]
//
// Actions (each is a distinct request shape):
//   { disabled }             — account revocation, syncs queue membership
//   { verifyPhoneOverride }   — admin marks phone verified without an OTP
//   { sendReset }             — issue a single-use reset link by email
//   { ...profile fields }     — Loop E1: name / email / role / password /
//                               simPort / extensionNumber. Before this the
//                               route's own comment said "there is still no
//                               route to RE-set a password after creation" —
//                               which meant an agent whose invite email
//                               never arrived, or who needed a password
//                               change while WhatsApp OTP was unconfigured,
//                               was permanently stuck. That is issue #2 from
//                               the objective.
const ProfileUpdateSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    email: z.string().email().optional(),
    role: z.enum(["AGENT", "SUPERVISOR", "ADMIN"]).optional(),
    // Set directly by an admin — long minimum, same as POST's create path.
    password: z.string().min(12).max(200).optional(),
    // null clears the SIM-port assignment; a number (1-4) assigns it.
    simPort: z.number().int().min(1).max(4).nullable().optional(),
    // null unlinks the current extension from this user; a number links an
    // existing orphan extension (created with no user). Tightened from
    // \d{3,6} 2026-08-29 to match POST /api/extensions' own pattern — see
    // that route's comment.
    extensionNumber: z.string().regex(/^[12]\d{3}$/, "extension must be a 4-digit number starting with 1 or 2").nullable().optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "No fields to update" });

const PatchSchema = z.union([
  z.object({ disabled: z.boolean() }),
  z.object({ verifyPhoneOverride: z.literal(true) }),
  z.object({ sendReset: z.literal(true) }),
  ProfileUpdateSchema,
]);

async function syncQueueMembership(number: string | undefined, present: boolean): Promise<string | undefined> {
  if (!number) return undefined;
  try {
    if (present) await addQueueMember(getAmiClient(), number);
    else await removeQueueMember(getAmiClient(), number);
    return undefined;
  } catch (err) {
    return `queue membership not updated: ${err instanceof Error ? err.message : "unknown error"}`;
  }
}

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });

  const target = await db.user.findUnique({ where: { id: params.id }, include: { extension: true, waInstance: true } });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Same escalation guard as user creation: a SUPERVISOR may not act on a
  // SUPERVISOR/ADMIN account, only AGENT accounts.
  if (target.role !== "AGENT" && guard.session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Only ADMIN may modify SUPERVISOR or ADMIN accounts." }, { status: 403 });
  }

  // ---- { disabled } ----
  if ("disabled" in parsed.data) {
    if (target.id === guard.session.user.id && parsed.data.disabled) {
      return NextResponse.json({ error: "You cannot disable your own account." }, { status: 400 });
    }
    const updated = await db.user.update({
      where: { id: target.id },
      data: { disabled: parsed.data.disabled, disabledAt: parsed.data.disabled ? new Date() : null },
    });
    await db.auditLog.create({
      data: { action: parsed.data.disabled ? "user.disable" : "user.enable", actorId: guard.session.user.id, targetId: target.id, metadata: { email: target.email } },
    });
    const queueWarning = await syncQueueMembership(target.extension?.number, !parsed.data.disabled);
    return NextResponse.json({ user: { id: updated.id, email: updated.email, disabled: updated.disabled }, warning: queueWarning });
  }

  // ---- { sendReset } ----
  if ("sendReset" in parsed.data) {
    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + RESET_LINK_TTL_MS);
    await db.invite.upsert({
      where: { userId: target.id },
      create: { userId: target.id, tokenHash, expiresAt, createdById: guard.session.user.id },
      update: { tokenHash, expiresAt, consumedAt: null, createdById: guard.session.user.id },
    });
    const resetUrl = `${process.env.AUTH_URL ?? ""}/invite/${rawToken}`;
    let emailWarning: string | undefined;
    try {
      await sendPasswordResetEmail(target.email, target.name, resetUrl);
    } catch (err) {
      // Loop B4 note: the raw token used to be returned in the response on
      // failure. Return only a generic warning — the admin can retry, and
      // the URL is in the server log.
      emailWarning = `Reset link created, but the email failed to send: ${err instanceof Error ? err.message : "unknown error"}.`;
    }
    await db.auditLog.create({
      data: { action: "user.password_reset_admin_triggered", actorId: guard.session.user.id, targetId: target.id, metadata: { email: target.email } },
    });
    return NextResponse.json({ ok: true, warning: emailWarning });
  }

  // ---- { verifyPhoneOverride } ----
  if ("verifyPhoneOverride" in parsed.data) {
    if (!target.phoneE164) {
      return NextResponse.json({ error: "This user has not submitted a contact number yet — nothing to verify." }, { status: 409 });
    }
    const updated = await db.user.update({
      where: { id: target.id },
      data: { phoneVerifiedAt: new Date(), phoneVerifiedByAdminId: guard.session.user.id },
    });
    await db.auditLog.create({
      data: { action: "user.phone_verified_by_admin", actorId: guard.session.user.id, targetId: target.id, metadata: { email: target.email, phoneE164: target.phoneE164 } },
    });
    await maybeCompleteProfile(target.id);
    return NextResponse.json({ user: { id: updated.id, email: updated.email, phoneVerifiedAt: updated.phoneVerifiedAt, phoneVerifiedByAdminId: updated.phoneVerifiedByAdminId } });
  }

  // ---- profile update (Loop E1) ----
  const p = parsed.data;
  const changes: string[] = [];
  const warnings: string[] = [];

  if (p.role && p.role !== target.role) {
    if (guard.session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Only ADMIN may change a user's role." }, { status: 403 });
    }
    if (target.id === guard.session.user.id) {
      return NextResponse.json({ error: "You cannot change your own role." }, { status: 400 });
    }
    if (target.role === "ADMIN" && p.role !== "ADMIN") {
      const adminCount = await db.user.count({ where: { role: "ADMIN", disabled: false } });
      if (adminCount <= 1) return NextResponse.json({ error: "Cannot demote the last active ADMIN." }, { status: 400 });
    }
  }

  if (p.email && p.email !== target.email) {
    const clash = await db.user.findUnique({ where: { email: p.email }, select: { id: true } });
    if (clash) return NextResponse.json({ error: "That email is already in use." }, { status: 409 });
  }

  const userData: Record<string, unknown> = {};
  if (p.name && p.name !== target.name) { userData.name = p.name; changes.push("name"); }
  if (p.email && p.email !== target.email) { userData.email = p.email; changes.push("email"); }
  if (p.role && p.role !== target.role) { userData.role = p.role; changes.push("role"); }
  if (p.password) {
    userData.passwordHash = await bcrypt.hash(p.password, 12);
    userData.passwordPlain = p.password;
    // Kills every other outstanding session on its next request — same
    // mechanism as a self-service reset (src/auth.ts jwt callback).
    userData.passwordChangedAt = new Date();
    changes.push("password");
  }

  // --- SIM port reassignment ---
  if (p.simPort !== undefined) {
    const current = target.waInstance?.simPort ?? null;
    if (p.simPort === null && current !== null) {
      await db.waInstance.update({ where: { simPort: current }, data: { assignedUserId: null } });
      changes.push("simPort:cleared");
    } else if (p.simPort !== null && p.simPort !== current) {
      const port = await db.waInstance.findUnique({
        where: { simPort: p.simPort },
        select: { id: true, assignedUserId: true, assignedUser: { select: { name: true, email: true } } },
      });
      if (!port) return NextResponse.json({ error: `SIM port ${p.simPort} has no paired WhatsApp instance.` }, { status: 409 });
      if (port.assignedUserId && port.assignedUserId !== target.id) {
        // Confirmed live 2026-08-29: naming the current holder is the one
        // real gap in an otherwise-correct exclusive/revoke-only model —
        // see POST /api/admin/users for the matching fix on creation.
        const holder = port.assignedUser ? `${port.assignedUser.name} (${port.assignedUser.email})` : "another agent";
        return NextResponse.json({ error: `SIM port ${p.simPort} is already assigned to ${holder}.` }, { status: 409 });
      }
      if (current !== null) await db.waInstance.update({ where: { simPort: current }, data: { assignedUserId: null } });
      await db.waInstance.update({ where: { simPort: p.simPort }, data: { assignedUserId: target.id } });
      changes.push(`simPort:${p.simPort}`);
    }
  }

  // --- Extension link / unlink ---
  if (p.extensionNumber !== undefined) {
    const currentExt = target.extension?.number ?? null;
    if (p.extensionNumber === null && currentExt) {
      await db.extension.update({ where: { number: currentExt }, data: { userId: null } });
      const w = await syncQueueMembership(currentExt, false);
      if (w) warnings.push(w);
      changes.push("extension:unlinked");
    } else if (p.extensionNumber !== null && p.extensionNumber !== currentExt) {
      const ext = await db.extension.findUnique({ where: { number: p.extensionNumber }, select: { userId: true } });
      if (!ext) return NextResponse.json({ error: `Extension ${p.extensionNumber} does not exist. Create it first in Extensions.` }, { status: 409 });
      if (ext.userId && ext.userId !== target.id) {
        return NextResponse.json({ error: `Extension ${p.extensionNumber} is already linked to another user.` }, { status: 409 });
      }
      if (currentExt) {
        await db.extension.update({ where: { number: currentExt }, data: { userId: null } });
        const w = await syncQueueMembership(currentExt, false);
        if (w) warnings.push(w);
      }
      await db.extension.update({ where: { number: p.extensionNumber }, data: { userId: target.id } });
      const w = await syncQueueMembership(p.extensionNumber, target.disabled ? false : true);
      if (w) warnings.push(w);
      changes.push(`extension:${p.extensionNumber}`);
    }
  }

  if (Object.keys(userData).length > 0) {
    await db.user.update({ where: { id: target.id }, data: userData });
  }

  if (changes.length === 0) {
    return NextResponse.json({ ok: true, changes: [], note: "No effective change." });
  }

  await db.auditLog.create({
    data: { action: "user.updated", actorId: guard.session.user.id, targetId: target.id, metadata: { email: target.email, changes } },
  });

  return NextResponse.json({ ok: true, changes, warning: warnings.length ? warnings.join(" ") : undefined });
}

// DELETE /api/admin/users/[id] — ADMIN only.
//
// Owner override (2026-08-29): this is a HARD delete. The original
// soft-delete + PII-scrub (which kept the row and its audit trail) is
// replaced — the operator wants a removed agent to leave no trace. Every
// row that FK-references this user is removed or re-pointed inside one
// transaction, then the User row itself is deleted. Extensions and SIM
// ports are released (unlinked), not deleted — they are shared infra, not
// personal data. See memory owner-overrides-security-model.
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  if (guard.session.user.role !== "ADMIN") {
    return NextResponse.json({ error: "Only ADMIN may delete accounts." }, { status: 403 });
  }

  const target = await db.user.findUnique({ where: { id: params.id }, include: { extension: true, waInstance: true } });
  if (!target) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (target.id === guard.session.user.id) {
    return NextResponse.json({ error: "You cannot delete your own account." }, { status: 400 });
  }
  if (target.role === "ADMIN") {
    const adminCount = await db.user.count({ where: { role: "ADMIN", disabled: false } });
    if (adminCount <= 1) return NextResponse.json({ error: "Cannot delete the last active ADMIN." }, { status: 400 });
  }

  const warnings: string[] = [];
  if (target.extension) {
    const w = await syncQueueMembership(target.extension.number, false);
    if (w) warnings.push(w);
  }

  const actorId = guard.session.user.id;
  const id = target.id;

  await db.$transaction([
    // Release shared infra (keep the rows).
    db.extension.updateMany({ where: { userId: id }, data: { userId: null } }),
    db.waInstance.updateMany({ where: { assignedUserId: id }, data: { assignedUserId: null } }),
    db.waInstance.updateMany({ where: { pairedByAdminId: id }, data: { pairedByAdminId: null } }),
    // Null every remaining nullable back-reference.
    db.user.updateMany({ where: { phoneVerifiedByAdminId: id }, data: { phoneVerifiedByAdminId: null } }),
    db.recording.updateMany({ where: { hiddenByUserId: id }, data: { hiddenByUserId: null } }),
    db.conversation.updateMany({ where: { assignedAgentId: id }, data: { assignedAgentId: null } }),
    db.smsAccessRequest.updateMany({ where: { decidedById: id }, data: { decidedById: null } }),
    // Reassign DNC entries (their addedById is required and the list must
    // survive the person who typed it) to the acting admin.
    db.doNotCallEntry.updateMany({ where: { addedById: id }, data: { addedById: actorId } }),
    // Delete rows whose FK to this user is required and which carry no
    // value once the person is gone.
    db.smsAccessRequest.deleteMany({ where: { requestedById: id } }),
    db.escalationAttempt.deleteMany({ where: { agentId: id } }),
    db.otpChallenge.deleteMany({ where: { userId: id } }),
    db.trustedDevice.deleteMany({ where: { userId: id } }),
    db.loginAttempt.deleteMany({ where: { userId: id } }),
    db.invite.deleteMany({ where: { OR: [{ userId: id }, { createdById: id }] } }),
    db.auditLog.deleteMany({ where: { OR: [{ actorId: id }, { targetId: id }] } }),
    db.user.delete({ where: { id } }),
    db.auditLog.create({
      data: { action: "user.deleted", actorId, metadata: { originalEmail: target.email, role: target.role, userId: id } },
    }),
  ]);

  return NextResponse.json({ ok: true, warning: warnings.length ? warnings.join(" ") : undefined });
}
