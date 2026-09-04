import { NextRequest, NextResponse } from "next/server";
import { requireStaffSession } from "@/lib/auth-guard";
import { patchDeal, DealPatchSchema } from "@/lib/crm/deals";

export const dynamic = "force-dynamic";

// PATCH /api/admin/crm/deals/[id] — staff can move any deal / reassign any
// owner. A stage change records the unified-timeline row (see patchDeal).
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const parsed = DealPatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }
  const deal = await patchDeal(db, params.id, parsed.data, guard.session.user.id);
  if (!deal) return NextResponse.json({ error: "Not found" }, { status: 404 });
  return NextResponse.json({ deal: { ...deal, value: Number(deal.value) } });
}

export async function DELETE(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;
  await db.deal.delete({ where: { id: params.id } }).catch(() => null);
  return NextResponse.json({ ok: true });
}
