import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { unsafeGlobalDb } from "@/lib/db";
import { requireStaffSession } from "@/lib/auth-guard";
import { parseReportFilters } from "../_lib";

export const dynamic = "force-dynamic";

// GET /api/admin/reports/dnc-trend?agentId=&from=&to= — DoNotCallEntry rows
// added per day (raw SQL for the date_trunc), split by source. Agent filter
// maps to addedById.
export async function GET(request: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { session } = guard;

  const { agentId, from, to } = parseReportFilters(request);
  const agentFilter = agentId
    ? Prisma.sql`AND "addedById" = ${agentId}`
    : Prisma.empty;

  // $queryRaw bypasses the tenant-scoped client's query extension entirely
  // (src/lib/db-tenant.ts's header comment: raw SQL is a known, unhandled
  // bypass) — RLS is the belt here, but this route also filters by hand as
  // braces, same as call-volume/route.ts.
  const raw = await unsafeGlobalDb.$queryRaw<{ day: Date; source: string; count: bigint }[]>`
    SELECT date_trunc('day', "createdAt") AS day, "source", count(*) AS count
    FROM "DoNotCallEntry"
    WHERE "tenantId" = ${session.user.tenantId} AND "createdAt" >= ${from} AND "createdAt" <= ${to}
    ${agentFilter}
    GROUP BY 1, 2
    ORDER BY 1
  `;

  const byDay = new Map<string, { day: string; manual: number; bulkImport: number; total: number }>();
  for (const r of raw) {
    const key = r.day.toISOString().slice(0, 10);
    const row = byDay.get(key) ?? { day: key, manual: 0, bulkImport: 0, total: 0 };
    const n = Number(r.count);
    row.total += n;
    if (r.source === "bulk_import") row.bulkImport += n;
    else row.manual += n;
    byDay.set(key, row);
  }

  return NextResponse.json({ rows: [...byDay.values()] });
}
