import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { requireStaffSession } from "@/lib/auth-guard";
import { recordActivity } from "@/lib/crm/activity";
import { NoteCreateSchema, toNoteThread, noteActivitySummary, noteActivityRefId } from "@/lib/crm/notes";

export const dynamic = "force-dynamic";

// GET/POST /api/admin/crm/companies/[id]/notes — threaded notes on a
// company (owner-page enchanted-sphinx plan, W5), backed by the new
// CompanyNote model (an exact structural mirror of DealNote).
//
// Activity has no companyId column — there is nowhere on the unified
// timeline model for a "company" event to hang directly. Rather than add a
// column for one feature, a company note's Activity row is attached to the
// company's most-recently-updated contact when one exists (the same
// judgment call the timeline already makes elsewhere for "the nearest
// contact"); when the company has no contacts at all, only the note itself
// is written and no Activity row is created (recordActivity() already
// no-ops when both contactId and dealId are null, so this falls out of its
// existing behavior rather than needing a special case here).
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const company = await db.company.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const rows = await db.companyNote.findMany({
    where: { companyId: params.id },
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

  const company = await db.company.findUnique({ where: { id: params.id }, select: { id: true } });
  if (!company) return NextResponse.json({ error: "Company not found" }, { status: 404 });

  const note = await db.companyNote.create({
    data: {
      companyId: company.id,
      authorId: session.user.id,
      body: parsed.data.body,
    } as unknown as Prisma.CompanyNoteUncheckedCreateInput,
    include: { author: { select: { id: true, name: true } } },
  });

  const nearestContact = await db.contact.findFirst({
    where: { companyId: company.id },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });

  await recordActivity(
    {
      type: "NOTE",
      summary: noteActivitySummary(parsed.data.body),
      refId: noteActivityRefId("company", note.id),
      contactId: nearestContact?.id ?? null,
      actorId: session.user.id,
    },
    db
  );

  return NextResponse.json({ note: toNoteThread([note])[0] }, { status: 201 });
}
