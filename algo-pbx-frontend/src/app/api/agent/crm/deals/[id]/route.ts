import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { canWriteDeal } from "@/lib/crm/deal-ownership";
import { patchDeal, DealPatchSchema } from "@/lib/crm/deals";

export const dynamic = "force-dynamic";

// PATCH /api/agent/crm/deals/[id] — a stage move (Kanban drag / mobile
// <Select>). Owner-scoped server-side: an AGENT may only move their own
// deals; an AGENT may not reassign ownerId (mirrors the contact rule).
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { role, id: userId } = guard.session.user;
  const { db } = guard;

  const parsed = DealPatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const existing = await db.deal.findUnique({
    where: { id: params.id },
    include: { owner: { select: { name: true } } },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!canWriteDeal({ role: role as "AGENT" | "SUPERVISOR" | "ADMIN", userId, ownerId: existing.ownerId })) {
    return NextResponse.json(
      { error: `This deal is owned by ${existing.owner?.name ?? "another agent"}.` },
      { status: 403 },
    );
  }
  if ("ownerId" in parsed.data && role === "AGENT") {
    return NextResponse.json({ error: "Agents cannot reassign deal ownership." }, { status: 403 });
  }

  const deal = await patchDeal(db, params.id, parsed.data, userId);
  return NextResponse.json({ deal: deal ? { ...deal, value: Number(deal.value) } : null });
}
