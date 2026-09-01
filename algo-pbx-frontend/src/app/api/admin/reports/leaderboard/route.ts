import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireStaffSession } from "@/lib/auth-guard";
import { parseReportFilters } from "../_lib";

export const dynamic = "force-dynamic";

// GET /api/admin/reports/leaderboard?agentId=&from=&to= — per agent: calls
// handled (CDR by agentExtension -> Extension -> User), dispositions logged
// (CallDisposition.agentId), and deals won (Deal in a stage where isWon and
// closedAt in range). All three windowed to the date range.
export async function GET(request: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const { agentId, from, to } = parseReportFilters(request);

  const users = await db.user.findMany({
    where: { disabled: false, ...(agentId ? { id: agentId } : {}) },
    select: {
      id: true,
      name: true,
      email: true,
      extension: { select: { number: true } },
    },
  });

  const [callsByExt, dispByAgent, wonByOwner] = await Promise.all([
    db.callDetailRecord.groupBy({
      by: ["agentExtension"],
      where: { agentExtension: { not: null }, startedAt: { gte: from, lte: to } },
      _count: { _all: true },
    }),
    db.callDisposition.groupBy({
      by: ["agentId"],
      where: { createdAt: { gte: from, lte: to } },
      _count: { _all: true },
    }),
    db.deal.groupBy({
      by: ["ownerId"],
      where: { stage: { isWon: true }, closedAt: { gte: from, lte: to } },
      _count: { _all: true },
      _sum: { value: true },
    }),
  ]);

  const callMap = new Map(callsByExt.map((c) => [c.agentExtension!, c._count._all]));
  const dispMap = new Map(dispByAgent.map((d) => [d.agentId, d._count._all]));
  const wonMap = new Map(wonByOwner.map((d) => [d.ownerId, d]));

  const rows = users
    .map((u) => {
      const won = wonMap.get(u.id);
      return {
        agentId: u.id,
        agentName: u.name ?? u.email,
        extension: u.extension?.number ?? null,
        calls: u.extension?.number ? callMap.get(u.extension.number) ?? 0 : 0,
        dispositions: dispMap.get(u.id) ?? 0,
        dealsWon: won?._count._all ?? 0,
        wonValue: Number(won?._sum.value ?? 0),
      };
    })
    .filter((r) => r.calls > 0 || r.dispositions > 0 || r.dealsWon > 0)
    .sort(
      (a, b) =>
        b.dealsWon - a.dealsWon || b.calls - a.calls || b.dispositions - a.dispositions,
    );

  return NextResponse.json({ rows });
}
