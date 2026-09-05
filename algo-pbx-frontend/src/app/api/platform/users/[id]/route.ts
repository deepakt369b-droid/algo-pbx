import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { unsafeGlobalDb as db } from "@/lib/db";
import { requirePlatformOwner } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { recordPlatformAudit, requireReason, MissingReasonError } from "@/lib/platform/audit";
import {
  canDisable,
  canEnable,
  canChangeRole,
  canResetTotp,
  type PlatformUserView,
} from "@/lib/platform/user-guardrails";

export const dynamic = "force-dynamic";

// PATCH /api/platform/users/[id] — enable, disable, change role, reset TOTP.
//
// The guardrails run HERE, server-side, against the live user set — not only
// in the UI. The last-owner rule protects against an irrecoverable state
// (nobody able to provision, bill or offboard; recoverable only with shell
// access to the production host), and a protection that a curl request can
// step around does not protect against anything.
//
// Refusals return the guardrail's own explanation, so the UI can show WHY
// rather than a generic 403 that leaves the operator guessing.

const BodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("disable"), reason: z.string() }),
  z.object({ action: z.literal("enable"), reason: z.string() }),
  z.object({
    action: z.literal("change_role"),
    role: z.enum(["PLATFORM_OWNER", "PLATFORM_SUPPORT"]),
    reason: z.string(),
    // Promotion to owner needs the same typed confirmation creating one does.
    confirmEmail: z.string().optional(),
  }),
  z.object({ action: z.literal("reset_totp"), reason: z.string() }),
]);

export const PATCH = withApiErrorHandler(async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const guard = await requirePlatformOwner();
  if ("response" in guard) return guard.response;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const body = parsed.data;

  let reason: string;
  try {
    reason = requireReason(body.reason, `platform_user.${body.action}`);
  } catch (err) {
    if (err instanceof MissingReasonError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  // The whole set, because every guardrail is a question about the set: "is
  // this the last enabled owner" cannot be answered from the target row.
  const all = (await db.platformUser.findMany({
    select: { id: true, email: true, role: true, disabled: true },
  })) as PlatformUserView[];

  const target = all.find((u) => u.id === params.id);
  if (!target) return NextResponse.json({ error: "Platform user not found" }, { status: 404 });

  const actorId = guard.session.user.id;

  switch (body.action) {
    case "disable": {
      const verdict = canDisable(target, all, actorId);
      if (!verdict.ok) return NextResponse.json({ error: verdict.reason, refused: true }, { status: 409 });
      const updated = await db.$transaction(async (tx) => {
        const u = await tx.platformUser.update({
          where: { id: target.id },
          data: { disabled: true, disabledAt: new Date() },
          select: { id: true, disabled: true, disabledAt: true },
        });
        await recordPlatformAudit(
          {
            action: "platform_user.disable",
            platformUserId: actorId,
            reason,
            metadata: { targetUserId: target.id, targetEmail: target.email, targetRole: target.role },
          },
          tx
        );
        return u;
      });
      // platform-guard.ts re-reads `disabled` on every request, so this takes
      // effect on the target's very next request rather than at session
      // expiry — worth stating back to the caller.
      return NextResponse.json({ user: updated, effective: "on their next request" });
    }

    case "enable": {
      const verdict = canEnable(target);
      if (!verdict.ok) return NextResponse.json({ error: verdict.reason, refused: true }, { status: 409 });
      const updated = await db.$transaction(async (tx) => {
        const u = await tx.platformUser.update({
          where: { id: target.id },
          data: { disabled: false, disabledAt: null },
          select: { id: true, disabled: true },
        });
        await recordPlatformAudit(
          {
            action: "platform_user.enable",
            platformUserId: actorId,
            reason,
            metadata: { targetUserId: target.id, targetEmail: target.email },
          },
          tx
        );
        return u;
      });
      return NextResponse.json({ user: updated });
    }

    case "change_role": {
      const verdict = canChangeRole(target, body.role, all, actorId);
      if (!verdict.ok) return NextResponse.json({ error: verdict.reason, refused: true }, { status: 409 });

      if (body.role === "PLATFORM_OWNER" && body.confirmEmail !== target.email) {
        return NextResponse.json(
          {
            error:
              "Promoting to PLATFORM_OWNER requires typed confirmation: send confirmEmail matching the target's email exactly.",
          },
          { status: 400 }
        );
      }

      const updated = await db.$transaction(async (tx) => {
        const u = await tx.platformUser.update({
          where: { id: target.id },
          data: { role: body.role },
          select: { id: true, role: true },
        });
        await recordPlatformAudit(
          {
            action: "platform_user.role_change",
            platformUserId: actorId,
            reason,
            metadata: {
              targetUserId: target.id,
              targetEmail: target.email,
              from: target.role,
              to: body.role,
            },
          },
          tx
        );
        return u;
      });
      return NextResponse.json({ user: updated });
    }

    case "reset_totp": {
      const verdict = canResetTotp(target);
      if (!verdict.ok) return NextResponse.json({ error: verdict.reason, refused: true }, { status: 409 });
      const updated = await db.$transaction(async (tx) => {
        const u = await tx.platformUser.update({
          where: { id: target.id },
          // Clearing both forces the existing /platform/setup enrolment flow
          // on next login. Deliberately NOT last-owner-guarded: this is the
          // recovery path for an owner who lost their authenticator, and
          // blocking it would create the very lockout the other rules exist
          // to prevent.
          data: { totpSecret: null, totpConfirmedAt: null, totpResetAt: new Date() },
          select: { id: true, totpConfirmedAt: true, totpResetAt: true },
        });
        await recordPlatformAudit(
          {
            action: "platform_user.totp_reset",
            platformUserId: actorId,
            reason,
            metadata: { targetUserId: target.id, targetEmail: target.email },
          },
          tx
        );
        return u;
      });
      return NextResponse.json({
        user: updated,
        notice: "They must re-enrol TOTP at their next login before reaching the console.",
      });
    }
  }
});
