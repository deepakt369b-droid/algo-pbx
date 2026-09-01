import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";
import { canWriteContact } from "@/lib/contact-ownership";

export const dynamic = "force-dynamic";

const CreateSchema = z.object({ body: z.string().min(1).max(4000) });

// POST /api/agent/crm/contacts/[id]/notes — any signed-in agent may add a
// note to a contact THEY OWN (or an unowned one, which claims it — see
// contact-ownership.ts). Feature B2 (2026-08-31) narrowed this from "any
// contact" to enforce the one-contact-one-owner conflict-prevention rule
// server-side, not just via the client hiding the form. authorId is always
// the caller, never client-supplied.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { role, id: userId } = guard.session.user;

  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const contact = await db.contact.findUnique({ where: { id: params.id }, include: { owner: { select: { name: true } } } });
  if (!contact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!canWriteContact({ role: role as "AGENT" | "SUPERVISOR" | "ADMIN", userId, ownerId: contact.ownerId })) {
    return NextResponse.json(
      { error: `This contact is owned by ${contact.owner?.name ?? "another agent"}. Request a transfer to edit it.` },
      { status: 403 }
    );
  }

  const note = await db.contactNote.create({
    data: { contactId: contact.id, authorId: guard.session.user.id, body: parsed.data.body },
    include: { author: { select: { id: true, name: true } } },
  });

  return NextResponse.json({ note }, { status: 201 });
}
