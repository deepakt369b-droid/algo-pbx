import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth-guard";
import { canWriteContact } from "@/lib/contact-ownership";

export const dynamic = "force-dynamic";

// GET /api/agent/crm/contacts/[id] — contact detail + notes + tasks +
// dispositions + a merged calls/messages timeline, for the agent console
// (P3). Session-authenticated, unlike /api/crm/contacts/[id]/activity
// (Bearer-key only). Uses CallDetailRecord.callerNumberE164 (indexed,
// P2) instead of that route's pre-existing approach of pulling the last
// 2000 CDRs and normalizing every one in-process — correct for any
// contact regardless of how far back their calls go, not just the most
// recent ~2000 system-wide.
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const contact = await db.contact.findUnique({
    where: { id: params.id },
    include: {
      owner: { select: { id: true, name: true } },
      companyRel: { select: { id: true, name: true, domain: true } },
      notes: { include: { author: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" } },
      tasks: {
        include: { assignee: { select: { id: true, name: true } }, deal: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
      },
      dispositions: { include: { agent: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" } },
      deals: {
        include: {
          deal: {
            include: {
              stage: { select: { id: true, name: true, isWon: true, isLost: true } },
              owner: { select: { id: true, name: true } },
            },
          },
        },
      },
    },
  });
  if (!contact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // S2b — the unified timeline now reads the Activity table (one row per
  // real-world event, populated live by recordActivity and backfilled by
  // POST /api/admin/maintenance/backfill-activity) instead of merging CDRs
  // and ChatMessages on the fly. Ordered occurredAt desc, capped at 100.
  // findFirst, not findUnique — numberE164 alone is no longer a unique key
  // by itself (it's `@@unique([tenantId, numberE164])` now, plan §1);
  // within this tenant's own scoped client it's effectively unique.
  const [dncEntry, activities] = await Promise.all([
    db.doNotCallEntry.findFirst({ where: { numberE164: contact.numberE164 } }),
    db.activity.findMany({
      where: { contactId: contact.id },
      orderBy: { occurredAt: "desc" },
      take: 100,
      include: { actor: { select: { id: true, name: true } } },
    }),
  ]);

  const timeline = activities.map((a) => ({
    type: a.type,
    timestamp: a.occurredAt,
    summary: a.summary,
    actor: a.actor?.name ?? null,
    refId: a.refId,
  }));

  const deals = contact.deals.map((dc) => ({
    id: dc.deal.id,
    name: dc.deal.name,
    value: Number(dc.deal.value),
    currency: dc.deal.currency,
    isPrimary: dc.isPrimary,
    stage: dc.deal.stage,
    owner: dc.deal.owner,
  }));

  return NextResponse.json({
    contact: { ...contact, deals, dncBlocked: Boolean(dncEntry) },
    timeline,
  });
}

const PatchSchema = z.object({
  displayName: z.string().max(200).optional(),
  email: z.string().email().nullable().optional(),
  company: z.string().max(200).nullable().optional(),
  companyId: z.string().nullable().optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  ownerId: z.string().nullable().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { role, id: userId } = guard.session.user;
  const { db } = guard;

  const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const existing = await db.contact.findUnique({ where: { id: params.id }, include: { owner: { select: { id: true, name: true } } } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Feature B2 — the core conflict-prevention requirement, server-side.
  // Client-side (contact-detail.tsx) already hides the write UI for a
  // non-owner; this is the independent enforcement that actually matters.
  if (!canWriteContact({ role: role as "AGENT" | "SUPERVISOR" | "ADMIN", userId, ownerId: existing.ownerId })) {
    return NextResponse.json(
      { error: `This contact is owned by ${existing.owner?.name ?? "another agent"}. Request a transfer to edit it.` },
      { status: 403 }
    );
  }

  // Reassignment ("who owns this contact") goes through the transfer-
  // request approve flow (POST/PATCH /api/agent/crm/transfer-requests) so
  // it's audited and, for a currently-owned contact, consent-gated — not
  // through this general-purpose field PATCH. An AGENT silently overwriting
  // ownerId here would be exactly the conflict-prevention hole B2/B3 exist
  // to close; SUPERVISOR/ADMIN keep the direct-reassign shortcut (B5's
  // admin reassign action also lands here).
  if ("ownerId" in parsed.data && role === "AGENT") {
    return NextResponse.json(
      { error: "Agents cannot reassign ownership directly — use Request transfer." },
      { status: 403 }
    );
  }

  const contact = await db.contact.update({ where: { id: params.id }, data: parsed.data });
  return NextResponse.json({ contact });
}
