import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { requireStaffSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

const PatchSchema = z.object({ ownerId: z.string().nullable() });

// PATCH /api/admin/contact-ownership/[contactId] — the "reassign action"
// half of Feature B5's admin view. Staff-only direct reassign, no consent
// gate (unlike the agent-facing transfer-request flow, B3) — an admin
// overriding ownership is the escape hatch when the request flow doesn't
// fit (e.g. clearing the deactivation pool by hand, or forcing a
// reassignment the current owner won't approve).
export async function PATCH(request: NextRequest, { params }: { params: { contactId: string } }) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { session, db } = guard;

  const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const existing = await db.contact.findUnique({ where: { id: params.contactId } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (parsed.data.ownerId) {
    const owner = await db.user.findUnique({ where: { id: parsed.data.ownerId }, select: { disabled: true } });
    if (!owner) return NextResponse.json({ error: "That user does not exist." }, { status: 400 });
    if (owner.disabled) return NextResponse.json({ error: "That user is disabled — pick an active agent." }, { status: 400 });
  }

  const contact = await db.contact.update({ where: { id: params.contactId }, data: { ownerId: parsed.data.ownerId } });

  // No `tenantId` here — the TenantClient extension force-injects it at
  // runtime (see src/lib/crm/activity.ts's comment on the same pattern);
  // the double-cast tells the compiler to trust that runtime guarantee.
  await db.auditLog.create({
    data: {
      action: "contact.owner_reassign",
      actorId: guard.session.user.id,
      targetId: contact.id,
      metadata: { fromOwnerId: existing.ownerId, toOwnerId: parsed.data.ownerId },
    } as unknown as Prisma.AuditLogUncheckedCreateInput,
  });

  return NextResponse.json({ contact });
}
