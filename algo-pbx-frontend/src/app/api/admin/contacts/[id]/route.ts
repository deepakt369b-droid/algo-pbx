import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireStaffSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// PATCH/DELETE /api/admin/contacts/[id] — edit or remove a single Contact.
// Same requireStaffSession gate as the collection route (see its header
// comment) — only ADMIN/SUPERVISOR sessions ever reach this page at all.

const UpdateContactSchema = z.object({
  displayName: z.string().max(200).nullable(),
});

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const parsed = UpdateContactSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const contact = await db.contact
    .update({ where: { id: params.id }, data: { displayName: parsed.data.displayName } })
    .catch(() => null);
  if (!contact) return NextResponse.json({ error: "Contact not found" }, { status: 404 });

  return NextResponse.json({ contact });
}

// Contact.id is a required, non-cascading FK on Conversation
// (prisma/schema.prisma's `contact Contact @relation(fields: [contactId],
// references: [id])` has no onDelete, so Prisma's default is Restrict) —
// unlike DELETE /api/dnc/[id]'s unconditional hard delete, deleting a
// Contact that still has message history would throw at the DB level. Check
// first and return a clear 409 instead of letting that throw become an
// unstyled 500, or silently swallowing it into a false "ok: true".
export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const conversationCount = await db.conversation.count({ where: { contactId: params.id } });
  if (conversationCount > 0) {
    return NextResponse.json(
      { error: "This contact has message history and can't be deleted. Clear its conversations first." },
      { status: 409 }
    );
  }

  const deleted = await db.contact.delete({ where: { id: params.id } }).catch(() => null);
  if (!deleted) return NextResponse.json({ error: "Contact not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
