import { NextRequest, NextResponse } from "next/server";
import { requireStaffSession } from "@/lib/auth-guard";
import { parseReportFilters } from "../_lib";

export const dynamic = "force-dynamic";

// GET /api/admin/reports/pipeline?agentId=&from=&to= — deal count + total
// value per PipelineStage, ordered by sortOrder, with stage-to-stage
// conversion % (this stage's count / the previous stage's count). Deals are
// scoped by ownerId (agent filter) and createdAt (date range).
export async function GET(request: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const { agentId, from, to } = parseReportFilters(request);

  const stages = await db.pipelineStage.findMany({ orderBy: { sortOrder: "asc" } });

  const grouped = await db.deal.groupBy({
    by: ["stageId"],
    where: {
      createdAt: { gte: from, lte: to },
      ...(agentId ? { ownerId: agentId } : {}),
    },
    _count: { _all: true },
    _sum: { value: true },
  });
  const byStage = new Map(grouped.map((g) => [g.stageId, g]));

  let prevCount: number | null = null;
  const rows = stages.map((s) => {
    const g = byStage.get(s.id);
    const count = g?._count._all ?? 0;
    const conversionPct =
      prevCount && prevCount > 0 ? Math.round((count / prevCount) * 100) : null;
    prevCount = count;
    return {
      stageId: s.id,
      name: s.name,
      isWon: s.isWon,
      isLost: s.isLost,
      count,
      value: Number(g?._sum.value ?? 0),
      conversionPct,
    };
  });

  return NextResponse.json({ rows });
}
