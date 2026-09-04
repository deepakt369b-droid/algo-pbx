import { NextRequest, NextResponse } from "next/server";
import { requireStaffSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// GET /api/admin/reports/agent-hours?period=day|week|month|all — sums
// talk time (billsecSec — actual answered duration, NOT durationSec,
// which also counts ringing/hold time) per agent extension. Reporting
// and monitoring only, explicitly not payroll — see this route's
// CAVEAT comment below for why that distinction matters here.
//
// CAVEAT (recorded, not silently absorbed): CallDetailRecord.agentExtension
// is a bare string, not a foreign key to Extension/User (schema.prisma
// documents this as a deliberate looseness elsewhere in the codebase).
// If an extension number is ever reassigned to a different agent,
// historical hours follow the EXTENSION, not the person — a new holder
// would inherit the previous agent's totals in this report. Acceptable
// for monitoring, which is this feature's stated purpose; would NOT be
// acceptable if these numbers ever fed pay — if that requirement
// changes, snapshot User.id onto each CDR at ingest time instead of
// joining through the mutable Extension.number string.
const PERIOD_TO_MS: Record<string, number | null> = {
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
  all: null,
};

export async function GET(request: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const period = request.nextUrl.searchParams.get("period") ?? "day";
  const windowMs = PERIOD_TO_MS[period];
  if (windowMs === undefined) {
    return NextResponse.json({ error: "period must be one of: day, week, month, all" }, { status: 400 });
  }

  const grouped = await db.callDetailRecord.groupBy({
    by: ["agentExtension"],
    where: {
      disposition: "ANSWERED",
      agentExtension: { not: null },
      ...(windowMs !== null ? { startedAt: { gte: new Date(Date.now() - windowMs) } } : {}),
    },
    _sum: { billsecSec: true },
    _count: { _all: true },
  });

  const extensions = await db.extension.findMany({
    where: { number: { in: grouped.map((g) => g.agentExtension!).filter(Boolean) } },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
  const extensionByNumber = new Map(extensions.map((e) => [e.number, e]));

  const rows = grouped
    .map((g) => {
      const ext = extensionByNumber.get(g.agentExtension!);
      return {
        extension: g.agentExtension,
        agentName: ext?.user?.name ?? null,
        agentEmail: ext?.user?.email ?? null,
        totalTalkSeconds: g._sum.billsecSec ?? 0,
        callCount: g._count._all,
      };
    })
    .sort((a, b) => b.totalTalkSeconds - a.totalTalkSeconds);

  return NextResponse.json({ period, rows });
}
