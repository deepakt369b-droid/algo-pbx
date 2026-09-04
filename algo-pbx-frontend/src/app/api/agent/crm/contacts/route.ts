import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/auth-guard";
import { normalizeToE164 } from "@/lib/phone-normalize";

export const dynamic = "force-dynamic";

// GET/POST /api/agent/crm/contacts — the CRM's contact list, session-
// authenticated (any signed-in role) unlike the pre-existing
// /api/crm/contacts, which is Bearer-API-key-only (src/lib/api-key-auth.ts)
// and therefore unreachable from a logged-in browser. This is a new,
// separate surface for the agent console (P3), not a replacement — the
// Bearer route stays for external CRM-webhook callers.
export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q")?.trim() || "";
  const limit = Math.min(Math.max(Number(searchParams.get("limit")) || 50, 1), 200);
  // Feature B2 — default filter is "Mine" (own + unowned); "All" is a
  // deliberate opt-in (?scope=all), enforced here rather than only in the
  // client so a non-owner can't page through everyone else's contacts by
  // hitting the API directly. active-call-contact.tsx's lookup-by-identity
  // call deliberately passes scope=all — resolving who's calling must see
  // every contact, not just the viewer's own (see that component).
  const scope = searchParams.get("scope") === "all" ? "all" : "mine";
  const userId = guard.session.user.id;

  const contacts = await db.contact.findMany({
    where: {
      AND: [
        q
          ? {
              OR: [
                { displayName: { contains: q, mode: "insensitive" } },
                { numberE164: { contains: q } },
                { company: { contains: q, mode: "insensitive" } },
                { email: { contains: q, mode: "insensitive" } },
              ],
            }
          : {},
        scope === "mine" ? { OR: [{ ownerId: userId }, { ownerId: null }] } : {},
      ],
    },
    // owner.extension (Feature B4) — active-call-contact.tsx's "Customer of
    // <owner>" popup needs a way to tell whether the owner is reachable for
    // a one-click warm transfer. Extension.status is self-reported agent
    // presence (AVAILABLE/BUSY/BREAK/OFFLINE), not a live PJSIP
    // registration/qualify read — real registration-state detection was
    // explicitly scoped out of an earlier session (EscalationTarget's
    // "offline" detection) as too complex; this reuses the one online-ish
    // signal that already exists rather than reopening that wall.
    include: { owner: { select: { id: true, name: true, extension: { select: { number: true, status: true } } } } },
    orderBy: { updatedAt: "desc" },
    take: limit,
  });

  return NextResponse.json({ contacts });
}

const CreateSchema = z.object({
  numberE164: z.string().min(1),
  displayName: z.string().max(200).optional(),
  email: z.string().email().optional(),
  company: z.string().max(200).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
});

export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const numberE164 = normalizeToE164(parsed.data.numberE164);
  if (!numberE164) {
    return NextResponse.json({ error: "Not a valid phone number" }, { status: 400 });
  }

  // findFirst, not findUnique — numberE164 alone is no longer a unique key
  // by itself (it's `@@unique([tenantId, numberE164])` now, plan §1);
  // within this tenant's own scoped client it's effectively unique.
  const existing = await db.contact.findFirst({ where: { numberE164 } });
  if (existing) {
    return NextResponse.json({ error: "A contact with this number already exists.", contact: existing }, { status: 409 });
  }

  // No `tenantId` — force-injected at runtime by the TenantClient
  // extension (see src/lib/crm/activity.ts's comment on the same pattern).
  const contact = await db.contact.create({
    data: {
      numberE164,
      displayName: parsed.data.displayName,
      email: parsed.data.email,
      company: parsed.data.company,
      tags: parsed.data.tags ?? [],
      ownerId: guard.session.user.id,
    } as unknown as Prisma.ContactUncheckedCreateInput,
  });

  return NextResponse.json({ contact }, { status: 201 });
}
