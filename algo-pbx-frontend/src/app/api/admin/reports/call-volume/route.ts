import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireStaffSession } from "@/lib/auth-guard";
import { parseReportFilters, resolveAgentExtension } from "../_lib";

export const dynamic = "force-dynamic";

// GET /api/admin/reports/call-volume?agentId=&from=&to= — CallDetailRecord
// counts bucketed by day and disposition. Feeds both Telephony-tab charts:
// the call-volume-over-time area chart (sum of all dispositions per day) and
// the answer-rate chart (ANSWERED / total per day). Raw SQL because Prisma
// groupBy can't date_trunc.
interface Row {
  day: string;
  answered: number;
  noAnswer: number;
  busy: number;
  failed: number;
  total: number;
}

export async function GET(request: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const { agentId, from, to } = parseReportFilters(request);
  const ext = await resolveAgentExtension(agentId);
  if (ext === null) return NextResponse.json({ rows: [] });

  const extFilter = ext ? Prisma.sql`AND "agentExtension" = ${ext}` : Prisma.empty;

  const raw = await db.$queryRaw<
    { day: Date; disposition: string; count: bigint }[]
  >`
    SELECT date_trunc('day', "startedAt") AS day, "disposition", count(*) AS count
    FROM "CallDetailRecord"
    WHERE "startedAt" >= ${from} AND "startedAt" <= ${to}
    ${extFilter}
    GROUP BY 1, 2
    ORDER BY 1
  `;

  const byDay = new Map<string, Row>();
  for (const r of raw) {
    const key = r.day.toISOString().slice(0, 10);
    const row =
      byDay.get(key) ??
      { day: key, answered: 0, noAnswer: 0, busy: 0, failed: 0, total: 0 };
    const n = Number(r.count);
    row.total += n;
    switch (r.disposition) {
      case "ANSWERED":
        row.answered += n;
        break;
      case "NO ANSWER":
        row.noAnswer += n;
        break;
      case "BUSY":
        row.busy += n;
        break;
      default:
        row.failed += n;
    }
    byDay.set(key, row);
  }

  const rows = [...byDay.values()].map((r) => ({
    ...r,
    answerRate: r.total > 0 ? Math.round((r.answered / r.total) * 100) : 0,
  }));

  return NextResponse.json({ rows });
}
