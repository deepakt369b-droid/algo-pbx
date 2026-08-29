import { randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAdminSession, requireSession, requireStaffSession } from "@/lib/auth-guard";
import { regeneratePjsipConfigAndReload } from "@/lib/pjsip-provision";
import { getAmiClient } from "@/lib/ami-client";
import { pauseQueueMember, removeQueueMember } from "@/lib/queue-membership";

export const dynamic = "force-dynamic";

const PatchSchema = z.union([
  z.object({ status: z.enum(["AVAILABLE", "BUSY", "BREAK", "OFFLINE"]) }),
  // Staff-only: attaches an existing orphan Extension (created via POST
  // /api/extensions with no user field) to a User. Without this there was
  // no way to link the two after creation — only the nested create inside
  // POST /api/admin/users ever set Extension.userId.
  z.object({ userId: z.string().min(1).nullable() }),
  // Staff-only (Loop C2) — which outbound dial-permission tier this
  // extension's generated PJSIP context= points at.
  z.object({ dialPermission: z.enum(["LOCAL", "NATIONAL", "INTERNATIONAL"]) }),
  // Staff-only (Loop C3) — offboarding gap: before this, revoking a SIP
  // secret required a DB-admin action, no in-product path existed. Same
  // one-time-disclosure treatment as creation (POST /api/extensions).
  z.object({ rotateSecret: z.literal(true) }),
]);

// PATCH /api/extensions/1001 { status } — agent status persistence, OR
// { userId } — admin/supervisor linking. Authorization differs per shape:
// an AGENT may only patch their OWN extension's status; only staff may
// link/unlink a userId, and only staff may force another extension's
// status (e.g. a stuck agent to OFFLINE).
export async function PATCH(req: NextRequest, { params }: { params: { number: string } }) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { session } = guard;

  const body = await req.json();
  const parsed = PatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const extension = await db.extension.findUnique({ where: { number: params.number } });
  if (!extension) {
    return NextResponse.json({ error: "Extension not found" }, { status: 404 });
  }

  if ("userId" in parsed.data) {
    // Loop B3: ADMIN, not just staff. Re-linking an extension to yourself
    // then reading GET /api/me/sip-credentials is a silent way for a
    // SUPERVISOR to harvest any other user's plaintext SIP secret + voicemail
    // PIN (including an ADMIN's). Now ADMIN-only and audit-logged.
    const adminGuard = await requireAdminSession();
    if ("response" in adminGuard) return adminGuard.response;

    if (parsed.data.userId) {
      const user = await db.user.findUnique({ where: { id: parsed.data.userId } });
      if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });
      const conflict = await db.extension.findUnique({ where: { userId: parsed.data.userId } });
      if (conflict && conflict.number !== extension.number) {
        return NextResponse.json({ error: `${user.name} already has extension ${conflict.number}.` }, { status: 409 });
      }
    }

    const updated = await db.extension.update({
      where: { number: params.number },
      data: { userId: parsed.data.userId },
    });
    await db.auditLog.create({
      data: {
        action: parsed.data.userId ? "extension.link" : "extension.unlink",
        actorId: adminGuard.session.user.id,
        targetId: extension.id,
        metadata: { number: extension.number, userId: parsed.data.userId, previousUserId: extension.userId },
      },
    });
    return NextResponse.json({ extension: updated });
  }

  if ("dialPermission" in parsed.data) {
    const staffGuard = await requireStaffSession();
    if ("response" in staffGuard) return staffGuard.response;

    const updated = await db.extension.update({
      where: { number: params.number },
      data: { dialPermission: parsed.data.dialPermission },
    });

    try {
      await regeneratePjsipConfigAndReload();
    } catch (err) {
      // Same pattern as POST /api/extensions: the DB row is updated but
      // Asterisk hasn't been told yet — surface this rather than claim
      // the new permission is already in effect.
      return NextResponse.json({
        extension: updated,
        warning: `Saved, but reloading Asterisk failed: ${err instanceof Error ? err.message : "unknown error"}. The old dial permission stays in effect until this is retried.`,
      });
    }

    return NextResponse.json({ extension: updated });
  }

  if ("rotateSecret" in parsed.data) {
    // Loop B3: ADMIN-only + audited, same reasoning as the userId branch —
    // the noisier variant of the same secret-harvest (the new secret is
    // returned in the response body).
    const adminGuard = await requireAdminSession();
    if ("response" in adminGuard) return adminGuard.response;

    const sipSecret = randomBytes(24).toString("hex");
    const updated = await db.extension.update({ where: { number: params.number }, data: { sipSecret } });
    await db.auditLog.create({
      data: { action: "extension.rotate_secret", actorId: adminGuard.session.user.id, targetId: extension.id, metadata: { number: extension.number } },
    });

    try {
      await regeneratePjsipConfigAndReload();
    } catch (err) {
      return NextResponse.json({
        extension: { ...updated, sipSecret: undefined },
        sipSecret,
        warning: `Secret rotated in the database, but reloading Asterisk failed: ${err instanceof Error ? err.message : "unknown error"}. The OLD secret stays in effect on the running Asterisk until this is retried — the softphone will need it again to reconnect.`,
      });
    }

    // One-time disclosure — same as creation, never returned by any GET.
    return NextResponse.json({ extension: { ...updated, sipSecret: undefined }, sipSecret });
  }

  const isOwnExtension = session.user.extension === params.number;
  const isStaff = session.user.role === "ADMIN" || session.user.role === "SUPERVISOR";
  if (!isOwnExtension && !isStaff) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const updated = await db.extension.update({
    where: { number: params.number },
    data: { status: parsed.data.status, lastSeenAt: new Date() },
  });

  // Confirmed live 2026-08-29: this used to write ONLY the DB column, with
  // nothing anywhere calling pauseQueueMember (src/lib/queue-membership.ts)
  // — an agent who set themselves "On Break" kept receiving real calls
  // through support_queue regardless, because Asterisk's own queue-member
  // pause state never changed. AVAILABLE unpauses; BUSY/BREAK/OFFLINE all
  // pause, since "on an outbound call" and "stepped away" both mean "don't
  // ring me from the queue right now" — Asterisk already stops offering a
  // genuinely-busy channel a second call regardless of pause state, so
  // pausing on BUSY is a no-op safety measure, not a behavior change.
  // Failure here is deliberately non-fatal: the DB write (what the UI
  // reads) already succeeded, and an AMI hiccup shouldn't block an agent
  // from changing their own status.
  try {
    await pauseQueueMember(getAmiClient(), params.number, parsed.data.status !== "AVAILABLE");
  } catch (err) {
    console.error(`Failed to sync queue pause state for extension ${params.number}:`, err);
  }

  return NextResponse.json({ extension: updated });
}

// DELETE /api/extensions/1001 — real hard delete (Loop C3 offboarding
// gap: before this, revoking a departed agent's access depended entirely
// on `User.disabled`, with no way to actually remove the extension/SIP
// credentials from the system at all). ADMIN-only, not SUPERVISOR — same
// tier as the recording hard-delete route (requireAdminSession), since
// this is the one truly destructive action in extension management.
export async function DELETE(_req: NextRequest, { params }: { params: { number: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const extension = await db.extension.findUnique({ where: { number: params.number } });
  if (!extension) return NextResponse.json({ error: "Extension not found" }, { status: 404 });

  // Best-effort — an AMI hiccup here must not block the actual deletion;
  // a stale queue-membership entry for a number that no longer exists is
  // a cosmetic cleanup issue, not a security one.
  await removeQueueMember(getAmiClient(), extension.number).catch(() => undefined);

  await db.extension.delete({ where: { number: params.number } });

  let reloadWarning: string | undefined;
  try {
    await regeneratePjsipConfigAndReload();
  } catch (err) {
    reloadWarning = `Extension deleted from the database, but reloading Asterisk failed: ${err instanceof Error ? err.message : "unknown error"}. The endpoint may still be able to register on the running Asterisk until this is retried.`;
  }

  await db.auditLog.create({
    data: { action: "extension.delete", actorId: guard.session.user.id, targetId: extension.id, metadata: { number: extension.number } },
  });

  return NextResponse.json({ ok: true, warning: reloadWarning });
}
