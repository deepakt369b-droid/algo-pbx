import { randomBytes, createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { unsafeGlobalDb as db } from "@/lib/db";
import { tenantDb } from "@/lib/db-tenant";
import { requirePlatformOwner } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { recordPlatformAudit, requireReason, MissingReasonError } from "@/lib/platform/audit";
import { sendPasswordResetEmail } from "@/lib/mail/resend";
import { getAmiClient } from "@/lib/ami-client";
import { addQueueMember, removeQueueMember } from "@/lib/queue-membership";
import { ensureSystemActorId } from "@/lib/support-grant";

export const dynamic = "force-dynamic";

// PATCH /api/platform/tenants/[id]/users/[userId] — owner-only actions on one
// user inside a tenant.
//
// `reset_password` deliberately reuses the SAME mechanism
// `PATCH /api/admin/users/[id]`'s `{ sendReset: true }` action already uses
// (an `Invite` row upserted with a single-use, 24h token, delivered by
// `sendPasswordResetEmail`) rather than inventing a second, platform-plane
// password-reset codepath. The staff-side route cannot be called directly
// from here — it sits behind `requireStaffSession()`, a tenant-side cookie a
// platform session does not hold — so this route re-issues the identical
// Invite/token/email sequence itself. If that sequence ever changes, both
// call sites need the same change; nothing here re-derives a token format or
// generates a password of its own.
const RESET_LINK_TTL_MS = 24 * 60 * 60 * 1000;

const BodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("disable"), reason: z.string() }),
  z.object({ action: z.literal("enable"), reason: z.string() }),
  z.object({ action: z.literal("reset_password"), reason: z.string() }),
  z.object({
    action: z.literal("change_role"),
    role: z.enum(["AGENT", "SUPERVISOR", "ADMIN"]),
    reason: z.string(),
  }),
]);

export const PATCH = withApiErrorHandler(async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; userId: string } }
) {
  const guard = await requirePlatformOwner();
  if ("response" in guard) return guard.response;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const body = parsed.data;

  const auditAction = `tenant.user.${body.action === "change_role" ? "change_role" : body.action}` as
    | "tenant.user.disable"
    | "tenant.user.enable"
    | "tenant.user.reset_password"
    | "tenant.user.change_role";

  let reason: string;
  try {
    reason = requireReason(body.reason, auditAction);
  } catch (err) {
    if (err instanceof MissingReasonError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  const tenant = await db.tenant.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  const scoped = tenantDb(tenant.id);
  const target = await scoped.user.findUnique({
    where: { id: params.userId },
    include: { extension: { select: { number: true } } },
  });
  if (!target || target.tenantId !== tenant.id) {
    return NextResponse.json({ error: "User not found in this tenant." }, { status: 404 });
  }

  let queueWarning: string | undefined;
  const before = { disabled: target.disabled, role: target.role };

  switch (body.action) {
    case "disable": {
      if (target.disabled) {
        return NextResponse.json({ error: "This user is already disabled." }, { status: 409 });
      }
      await scoped.user.update({
        where: { id: target.id },
        data: { disabled: true, disabledAt: new Date() },
      });
      if (target.extension?.number) {
        try {
          await removeQueueMember(getAmiClient(), target.extension.number);
        } catch (err) {
          queueWarning = `Queue membership not updated: ${err instanceof Error ? err.message : "unknown error"}`;
        }
      }
      break;
    }
    case "enable": {
      if (!target.disabled) {
        return NextResponse.json({ error: "This user is not disabled." }, { status: 409 });
      }
      await scoped.user.update({
        where: { id: target.id },
        data: { disabled: false, disabledAt: null },
      });
      if (target.extension?.number) {
        try {
          await addQueueMember(getAmiClient(), target.extension.number);
        } catch (err) {
          queueWarning = `Queue membership not updated: ${err instanceof Error ? err.message : "unknown error"}`;
        }
      }
      break;
    }
    case "change_role": {
      if (body.role === target.role) {
        return NextResponse.json({ error: `This user already has the role ${body.role}.` }, { status: 409 });
      }
      await scoped.user.update({ where: { id: target.id }, data: { role: body.role } });
      break;
    }
    case "reset_password": {
      const rawToken = randomBytes(32).toString("hex");
      const tokenHash = createHash("sha256").update(rawToken).digest("hex");
      const expiresAt = new Date(Date.now() + RESET_LINK_TTL_MS);
      // Invite.createdById is a required FK to this tenant's own User table
      // — a PlatformUser is deliberately not one (see support-grant.ts's own
      // header comment on ensureSystemActorId), so the reset is attributed
      // to the same per-tenant "do not use" system actor every other
      // platform-plane write into tenant data already uses. The REAL actor
      // (this platform owner) is recorded in the PlatformAuditLog row below.
      const systemActorId = await ensureSystemActorId(db, tenant.id);
      await scoped.invite.upsert({
        where: { userId: target.id },
        create: { userId: target.id, tokenHash, expiresAt, tenantId: tenant.id, createdById: systemActorId },
        update: { tokenHash, expiresAt, consumedAt: null, createdById: systemActorId },
      });
      const resetUrl = `${process.env.AUTH_URL ?? ""}/invite/${rawToken}`;
      try {
        await sendPasswordResetEmail(target.email, target.name, resetUrl);
      } catch (err) {
        queueWarning = `Reset link created, but the email failed to send: ${err instanceof Error ? err.message : "unknown error"}.`;
      }
      break;
    }
  }

  await recordPlatformAudit({
    action: auditAction,
    platformUserId: guard.session.user.id,
    tenantId: tenant.id,
    reason,
    metadata: {
      targetUserId: target.id,
      targetEmail: target.email,
      before,
      ...(body.action === "change_role" ? { after: { role: body.role } } : {}),
    },
  });

  return NextResponse.json({ ok: true, warning: queueWarning });
});
