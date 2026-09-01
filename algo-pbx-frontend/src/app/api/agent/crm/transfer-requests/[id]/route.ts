import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// PATCH /api/agent/crm/transfer-requests/[id] — approve/decline a contact
// ownership transfer. Guard: the CURRENT owner (they're the one being asked
// to give the contact up) OR SUPERVISOR/ADMIN (requireStaffSession-shaped,
// checked inline here since the "OR the current owner" half needs the row
// first) — matching the operator's explicit spec ("the current owner OR a
// SUPERVISOR/ADMIN"). Approving flips Contact.ownerId to the requester and
// writes AuditLog, mirroring PATCH /api/admin/messaging/sms-access-
// requests/[id]'s approve/decline shape.
const ActionSchema = z.object({ action: z.enum(["approve", "decline"]) });

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { role, id: userId } = guard.session.user;

  const parsed = ActionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const existing = await db.contactTransferRequest.findUnique({ where: { id: params.id } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const isStaff = role === "SUPERVISOR" || role === "ADMIN";
  if (!isStaff && existing.currentOwnerId !== userId) {
    return NextResponse.json({ error: "Only the current owner or a supervisor/admin may decide this request." }, { status: 403 });
  }
  if (existing.status !== "PENDING") {
    return NextResponse.json({ error: "This request has already been decided." }, { status: 409 });
  }

  const nextStatus = parsed.data.action === "approve" ? "APPROVED" : "DECLINED";

  const updated = await db.$transaction(async (tx) => {
    const decided = await tx.contactTransferRequest.update({
      where: { id: existing.id },
      data: { status: nextStatus, decidedById: userId, decidedAt: new Date() },
    });

    if (nextStatus === "APPROVED") {
      // Race guard: only flip ownership if it's still held by the owner
      // this request was made against — a second, independently-approved
      // request (or a manual admin reassign) landing first must not be
      // silently clobbered.
      await tx.contact.updateMany({
        where: { id: existing.contactId, ownerId: existing.currentOwnerId },
        data: { ownerId: existing.requestedById },
      });
    }

    return decided;
  });

  await db.auditLog.create({
    data: {
      action: `contact.transfer_${parsed.data.action}`,
      actorId: userId,
      targetId: existing.contactId,
      metadata: { requestId: existing.id, requestedById: existing.requestedById, currentOwnerId: existing.currentOwnerId },
    },
  });

  return NextResponse.json({ request: updated });
}
