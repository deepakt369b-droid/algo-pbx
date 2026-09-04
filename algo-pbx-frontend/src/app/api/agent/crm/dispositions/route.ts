import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/auth-guard";
import { canWriteContact } from "@/lib/contact-ownership";
import { recordActivity } from "@/lib/crm/activity";

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
  const { db } = guard;

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
    // No `tenantId` — force-injected at runtime by the TenantClient
    // extension (see src/lib/crm/activity.ts's comment on the same pattern).
    const created = await tx.callDisposition.create({
      data: {
        contactId: contact.id,
        cdrUniqueId: parsed.data.cdrUniqueId,
        outcome: parsed.data.outcome,
        note: parsed.data.note,
        agentId: guard.session.user.id,
      } as unknown as Prisma.CallDispositionUncheckedCreateInput,
      include: { agent: { select: { id: true, name: true } } },
    });

    if (parsed.data.outcome === "DNC") {
      // Was a plain upsert keyed on numberE164 alone — no longer possible,
      // that field is tenant-composite now (`@@unique([tenantId,
      // numberE164])`, plan §1) and TenantClient deliberately doesn't
      // expose the raw tenantId this function would need to build that
      // compound-key literal itself. findFirst (tenant-filtered
      // automatically) + create/update instead — same pattern as
      // src/lib/crm/activity.ts's recordActivity(). A number can already be
      // on the list; recording the disposition must not fail because of
      // that.
      const existingEntry = await tx.doNotCallEntry.findFirst({ where: { numberE164: contact.numberE164 } });
      if (!existingEntry) {
        await tx.doNotCallEntry.create({
          data: {
            numberE164: contact.numberE164,
            reason: parsed.data.note ?? "Marked DNC from a call disposition",
            source: "manual",
            addedById: guard.session.user.id,
          } as unknown as Prisma.DoNotCallEntryUncheckedCreateInput,
        });
      }
    }

    return created;
  });

  await recordActivity(
    {
      type: "NOTE",
      summary: `Disposition: ${parsed.data.outcome}${parsed.data.note ? ` — ${parsed.data.note.slice(0, 120)}` : ""}`,
      refId: disposition.id,
      contactId: contact.id,
      actorId: guard.session.user.id,
    },
    db,
  );

  return NextResponse.json({ disposition }, { status: 201 });
}
