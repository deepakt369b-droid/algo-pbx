import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAdminSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// PATCH /api/admin/messaging/sms-access-requests/[id] — approve / decline /
// revoke one agent's request to see a sensitive SMS body. Every transition
// is audit-logged; approval is time-boxed (15 minutes) so a forgotten
// approval doesn't leave a body permanently unlocked. Admin-only — this is
// the entire enforcement point for the "admin approves, agent can't
// self-serve" requirement.
const ActionSchema = z.object({
  action: z.enum(["approve", "decline", "revoke"]),
});

const APPROVAL_TTL_MS = 15 * 60 * 1000;

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const parsed = ActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const existing = await db.smsAccessRequest.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (parsed.data.action === "revoke" && existing.status !== "APPROVED") {
    return NextResponse.json({ error: "Only an APPROVED request can be revoked." }, { status: 409 });
  }
  if (parsed.data.action !== "revoke" && existing.status !== "PENDING") {
    return NextResponse.json({ error: "This request has already been decided." }, { status: 409 });
  }

  const nextStatus =
    parsed.data.action === "approve" ? "APPROVED" : parsed.data.action === "decline" ? "DECLINED" : "REVOKED";

  const updated = await db.smsAccessRequest.update({
    where: { id: existing.id },
    data: {
      status: nextStatus,
      decidedById: guard.session.user.id,
      decidedAt: new Date(),
      expiresAt: nextStatus === "APPROVED" ? new Date(Date.now() + APPROVAL_TTL_MS) : existing.expiresAt,
    },
  });

  await db.auditLog.create({
    data: {
      action: `sms_access.${parsed.data.action}`,
      actorId: guard.session.user.id,
      targetId: existing.messageId,
      metadata: { requestId: existing.id, requestedById: existing.requestedById },
    },
  });

  return NextResponse.json({ request: updated });
}
