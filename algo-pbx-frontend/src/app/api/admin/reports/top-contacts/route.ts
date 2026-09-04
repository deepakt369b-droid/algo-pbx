import { NextRequest, NextResponse } from "next/server";
import { requireStaffSession } from "@/lib/auth-guard";
import { parseReportFilters } from "../_lib";

export const dynamic = "force-dynamic";

// GET /api/admin/reports/top-contacts?agentId=&from=&to= — the 10 contacts
// with the most Activity rows in range, joined to a display name. Scoped by
// actorId (agent filter) and occurredAt.
export async function GET(request: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const { agentId, from, to } = parseReportFilters(request);

  const grouped = await db.activity.groupBy({
    by: ["contactId"],
    where: {
      contactId: { not: null },
      occurredAt: { gte: from, lte: to },
      ...(agentId ? { actorId: agentId } : {}),
    },
    _count: { _all: true },
    orderBy: { _count: { contactId: "desc" } },
    take: 10,
  });

  const ids = grouped.map((g) => g.contactId!).filter(Boolean);
  const contacts = await db.contact.findMany({
    where: { id: { in: ids } },
    select: { id: true, displayName: true, numberE164: true, company: true },
  });
  const byId = new Map(contacts.map((c) => [c.id, c]));

  const rows = grouped.map((g) => {
    const c = byId.get(g.contactId!);
    return {
      contactId: g.contactId,
      name: c?.displayName ?? c?.numberE164 ?? "Unknown",
      company: c?.company ?? null,
      interactions: g._count._all,
    };
  });

  return NextResponse.json({ rows });
}
