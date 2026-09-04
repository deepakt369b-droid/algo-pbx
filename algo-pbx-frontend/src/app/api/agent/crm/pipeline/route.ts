import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";
import { loadPipeline } from "@/lib/crm/pipeline-data";
import { createDeal, DealCreateSchema } from "@/lib/crm/deals";

export const dynamic = "force-dynamic";

// GET /api/agent/crm/pipeline — the agent Kanban. Owner-scoped server-side:
// an AGENT sees only their own deals; staff see everything (same oversight
// convention as the contacts list).
export async function GET() {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { role, id } = guard.session.user;
  const scope = role === "AGENT" ? id : null;
  return NextResponse.json(await loadPipeline(guard.db, scope));
}

export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;

  const parsed = DealCreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }
  // An agent can only create deals they own.
  const data =
    guard.session.user.role === "AGENT"
      ? { ...parsed.data, ownerId: guard.session.user.id }
      : parsed.data;
  const deal = await createDeal(guard.db, data, guard.session.user.id);
  return NextResponse.json({ deal: { ...deal, value: Number(deal.value) } }, { status: 201 });
}
