import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { unsafeGlobalDb as db } from "@/lib/db";
import { requirePlatformOwner } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { recordPlatformAudit, requireReason, MissingReasonError } from "@/lib/platform/audit";
import { canAssignExtension, canUnassignExtension } from "@/lib/platform/extension-assignment";

export const dynamic = "force-dynamic";

// PATCH /api/platform/tenants/[id]/extensions/[extensionId] — owner-only
// extension assignment and dial-permission control for the tenant
// management modal (W1, extensions panel).
//
// `assign_user` / `unassign_user` are guarded by canAssignExtension() /
// canUnassignExtension() (src/lib/platform/extension-assignment.ts) — pure
// so the "user already holds a different extension" 409 stays testable
// without a database.

const BodySchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("assign_user"), userId: z.string().min(1), reason: z.string() }),
  z.object({ action: z.literal("unassign_user"), reason: z.string() }),
  z.object({
    action: z.literal("set_dial_permission"),
    dialPermission: z.enum(["LOCAL", "NATIONAL", "INTERNATIONAL"]),
    reason: z.string(),
  }),
]);

export const PATCH = withApiErrorHandler(async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; extensionId: string } }
) {
  const guard = await requirePlatformOwner();
  if ("response" in guard) return guard.response;

  const parsed = BodySchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const body = parsed.data;

  const auditAction =
    body.action === "assign_user"
      ? ("tenant.extension.assign" as const)
      : body.action === "unassign_user"
        ? ("tenant.extension.unassign" as const)
        : ("tenant.extension.dial_permission" as const);

  let reason: string;
  try {
    reason = requireReason(body.reason, auditAction);
  } catch (err) {
    if (err instanceof MissingReasonError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  const extension = await db.extension.findUnique({
    where: { id: params.extensionId },
    select: {
      id: true,
      tenantId: true,
      number: true,
      dialPermission: true,
      userId: true,
      user: { select: { id: true, email: true } },
    },
  });
  if (!extension || extension.tenantId !== params.id) {
    return NextResponse.json({ error: "Extension not found" }, { status: 404 });
  }

  if (body.action === "assign_user") {
    const targetUser = await db.user.findUnique({
      where: { id: body.userId },
      select: { id: true, tenantId: true, email: true, extension: { select: { id: true } } },
    });
    if (!targetUser) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const verdict = canAssignExtension({
      extensionTenantId: extension.tenantId,
      userTenantId: targetUser.tenantId,
      userExistingExtensionId: targetUser.extension?.id ?? null,
      targetExtensionId: extension.id,
    });
    if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: 409 });

    const updated = await db.$transaction(async (tx) => {
      const e = await tx.extension.update({
        where: { id: extension.id },
        data: { userId: targetUser.id },
        select: { id: true, number: true, userId: true, user: { select: { id: true, email: true, name: true } } },
      });
      await recordPlatformAudit(
        {
          action: "tenant.extension.assign",
          platformUserId: guard.session.user.id,
          tenantId: params.id,
          reason,
          metadata: { extensionId: extension.id, extensionNumber: extension.number, before: extension.user?.email ?? null, after: targetUser.email },
        },
        tx
      );
      return e;
    });

    return NextResponse.json({ extension: updated });
  }

  if (body.action === "unassign_user") {
    const verdict = canUnassignExtension({ hasAssignedUser: extension.userId !== null });
    if (!verdict.ok) return NextResponse.json({ error: verdict.error }, { status: 409 });

    const updated = await db.$transaction(async (tx) => {
      const e = await tx.extension.update({
        where: { id: extension.id },
        data: { userId: null },
        select: { id: true, number: true, userId: true, user: { select: { id: true, email: true, name: true } } },
      });
      await recordPlatformAudit(
        {
          action: "tenant.extension.unassign",
          platformUserId: guard.session.user.id,
          tenantId: params.id,
          reason,
          metadata: { extensionId: extension.id, extensionNumber: extension.number, before: extension.user?.email ?? null },
        },
        tx
      );
      return e;
    });

    return NextResponse.json({ extension: updated });
  }

  // set_dial_permission
  const updated = await db.$transaction(async (tx) => {
    const e = await tx.extension.update({
      where: { id: extension.id },
      data: { dialPermission: body.dialPermission },
      select: { id: true, number: true, dialPermission: true },
    });
    await recordPlatformAudit(
      {
        action: "tenant.extension.dial_permission",
        platformUserId: guard.session.user.id,
        tenantId: params.id,
        reason,
        metadata: { extensionId: extension.id, extensionNumber: extension.number, before: extension.dialPermission, after: body.dialPermission },
      },
      tx
    );
    return e;
  });

  return NextResponse.json({ extension: updated });
});
