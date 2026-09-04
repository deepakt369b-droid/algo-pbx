import { NextRequest, NextResponse } from "next/server";
import { requireStaffSession } from "@/lib/auth-guard";
import { parseReportFilters } from "../_lib";

export const dynamic = "force-dynamic";

const OUTCOMES = ["INTERESTED", "CALLBACK", "NOT_INTERESTED", "DNC"] as const;

// GET /api/admin/reports/dispositions?agentId=&from=&to= — CallDisposition
// rows grouped by outcome, scoped by agentId (CallDisposition.agentId is a
// real User FK, unlike CDR) and createdAt.
export async function GET(request: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const { agentId, from, to } = parseReportFilters(request);

  const grouped = await db.callDisposition.groupBy({
    by: ["outcome"],
    where: {
      createdAt: { gte: from, lte: to },
      ...(agentId ? { agentId } : {}),
    },
    _count: { _all: true },
  });
  const byOutcome = new Map(grouped.map((g) => [g.outcome, g._count._all]));

  const rows = OUTCOMES.map((outcome) => ({
    outcome,
    count: byOutcome.get(outcome) ?? 0,
  }));

  return NextResponse.json({ rows });
}
