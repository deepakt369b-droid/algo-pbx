import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";
import { canWriteContact } from "@/lib/contact-ownership";

export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  contactId: z.string(),
  cdrUniqueId: z.string().optional(),
  outcome: z.enum(["INTERESTED", "CALLBACK", "NOT_INTERESTED", "DNC"]),
  note: z.string().max(2000).optional(),
});

// POST /api/agent/crm/dispositions — the console's post-call disposition
// bar (P3). Choosing DNC also writes a DoNotCallEntry, in the SAME
// transaction (plan requirement, P2) — a disposition recorded as DNC
// without the blocklist entry actually landing would be a compliance gap,
// not just a UI inconsistency.
export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { role, id: userId } = guard.session.user;

  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const contact = await db.contact.findUnique({ where: { id: parsed.data.contactId }, include: { owner: { select: { name: true } } } });
  if (!contact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Feature B2 (2026-08-31) — same conflict-prevention enforcement as
  // notes/tasks: a non-owner may not record a disposition on an OWNED
  // contact (a DNC disposition writes a compliance-relevant DoNotCallEntry
  // below, which makes this the one CRM write where a bypass matters most).
  if (!canWriteContact({ role: role as "AGENT" | "SUPERVISOR" | "ADMIN", userId, ownerId: contact.ownerId })) {
    return NextResponse.json(
      { error: `This contact is owned by ${contact.owner?.name ?? "another agent"}. Request a transfer to edit it.` },
      { status: 403 }
    );
  }

  const disposition = await db.$transaction(async (tx) => {
    const created = await tx.callDisposition.create({
      data: {
        contactId: contact.id,
        cdrUniqueId: parsed.data.cdrUniqueId,
        outcome: parsed.data.outcome,
        note: parsed.data.note,
        agentId: guard.session.user.id,
      },
      include: { agent: { select: { id: true, name: true } } },
    });

    if (parsed.data.outcome === "DNC") {
      // Same shape as the DNC bulk-import path (source distinguishes how
      // an entry got there) — upsert since a number can already be on the
      // list; recording the disposition must not fail because of that.
      await tx.doNotCallEntry.upsert({
        where: { numberE164: contact.numberE164 },
        create: {
          numberE164: contact.numberE164,
          reason: parsed.data.note ?? "Marked DNC from a call disposition",
          source: "manual",
          addedById: guard.session.user.id,
        },
        update: {},
      });
    }

    return created;
  });

  return NextResponse.json({ disposition }, { status: 201 });
}
