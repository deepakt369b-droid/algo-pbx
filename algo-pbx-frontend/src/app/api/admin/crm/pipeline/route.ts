import { NextRequest, NextResponse } from "next/server";
import { requireStaffSession } from "@/lib/auth-guard";
import { loadPipeline } from "@/lib/crm/pipeline-data";
import { createDeal, DealCreateSchema } from "@/lib/crm/deals";

export const dynamic = "force-dynamic";

// GET /api/admin/crm/pipeline — every stage + every deal, for the staff
// Kanban. POST creates a deal.
export async function GET() {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  return NextResponse.json(await loadPipeline(guard.db, null));
}

export async function POST(request: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const parsed = DealCreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }
  const deal = await createDeal(guard.db, parsed.data, guard.session.user.id);
  return NextResponse.json({ deal: { ...deal, value: Number(deal.value) } }, { status: 201 });
}
