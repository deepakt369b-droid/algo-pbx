import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { requireStaffSession } from "@/lib/auth-guard";
import { primaryContactId } from "@/lib/crm/pipeline-data";
import { recordActivity } from "@/lib/crm/activity";
import { NoteCreateSchema, toNoteThread, noteActivitySummary, noteActivityRefId } from "@/lib/crm/notes";

export const dynamic = "force-dynamic";

// GET/POST /api/admin/crm/deals/[id]/notes — threaded notes on a deal
// (owner-page enchanted-sphinx plan, W5). Activates DealNote, which was
// declared in the schema but had zero code using it before this route.
//
// Every POST also writes an Activity row via recordActivity() so the note
// shows up on the unified timeline — attached to the deal directly, and
// additionally to the deal's primary contact when one exists (recordActivity
// happily accepts both dealId and contactId on the same row).
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const deal = await db.deal.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!deal) return NextResponse.json({ error: "Deal not found" }, { status: 404 });

  const rows = await db.dealNote.findMany({
    where: { dealId: params.id },
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

  const deal = await db.deal.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!deal) return NextResponse.json({ error: "Deal not found" }, { status: 404 });

  const note = await db.dealNote.create({
    data: {
      dealId: deal.id,
      authorId: session.user.id,
      body: parsed.data.body,
    } as unknown as Prisma.DealNoteUncheckedCreateInput,
    include: { author: { select: { id: true, name: true } } },
  });

  const contactId = await primaryContactId(deal.id);
  await recordActivity(
    {
      type: "NOTE",
      summary: noteActivitySummary(parsed.data.body),
      refId: noteActivityRefId("deal", note.id),
      dealId: deal.id,
      contactId,
      actorId: session.user.id,
    },
    db
  );

  return NextResponse.json({ note: toNoteThread([note])[0] }, { status: 201 });
}
