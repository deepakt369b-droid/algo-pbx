import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { requireStaffSession } from "@/lib/auth-guard";
import { recordActivity } from "@/lib/crm/activity";
import { NoteCreateSchema, toNoteThread, noteActivitySummary, noteActivityRefId } from "@/lib/crm/notes";

export const dynamic = "force-dynamic";

// GET/POST /api/admin/contacts/[id]/notes — admin-plane sibling of
// /api/agent/crm/contacts/[id]/notes (owner-page enchanted-sphinx plan,
// W5). Deliberately does NOT apply that route's canWriteContact() ownership
// gate — staff (ADMIN/SUPERVISOR) may note any contact, the same "staff
// sees everything" scope every other /api/admin/crm/** route already uses.
// authorId is always the caller, never client-supplied.
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const contact = await db.contact.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!contact) return NextResponse.json({ error: "Contact not found" }, { status: 404 });

  const rows = await db.contactNote.findMany({
    where: { contactId: params.id },
    include: { author: { select: { id: true, name: true } } },
  });
  return NextResponse.json({ notes: toNoteThread(rows) });
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db, session } = guard;

  const parsed = NoteCreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const contact = await db.contact.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!contact) return NextResponse.json({ error: "Contact not found" }, { status: 404 });

  const note = await db.contactNote.create({
    data: {
      contactId: contact.id,
      authorId: session.user.id,
      body: parsed.data.body,
    } as unknown as Prisma.ContactNoteUncheckedCreateInput,
    include: { author: { select: { id: true, name: true } } },
  });

  await recordActivity(
    {
      type: "NOTE",
      summary: noteActivitySummary(parsed.data.body),
      refId: noteActivityRefId("contact", note.id),
      contactId: contact.id,
      actorId: session.user.id,
    },
    db
  );

  return NextResponse.json({ note: toNoteThread([note])[0] }, { status: 201 });
}
