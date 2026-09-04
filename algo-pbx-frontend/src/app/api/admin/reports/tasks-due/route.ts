import { NextRequest, NextResponse } from "next/server";
import { requireStaffSession } from "@/lib/auth-guard";
import { parseReportFilters } from "../_lib";

export const dynamic = "force-dynamic";

// GET /api/admin/reports/tasks-due?agentId= — open ContactTask rows
// (completedAt IS NULL) bucketed by how soon they are due. This card is
// "now"-relative, so it uses only the agent filter, not the date range.
export async function GET(request: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const { agentId } = parseReportFilters(request);

  const tasks = await db.contactTask.findMany({
    where: { completedAt: null, ...(agentId ? { assigneeId: agentId } : {}) },
    select: { dueAt: true },
  });

  const now = new Date();
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  const endOfWeek = new Date(endOfToday.getTime() + 6 * 24 * 60 * 60 * 1000);

  const buckets = { overdue: 0, today: 0, thisWeek: 0, later: 0, noDueDate: 0 };
  for (const t of tasks) {
    if (!t.dueAt) buckets.noDueDate++;
    else if (t.dueAt < now) buckets.overdue++;
    else if (t.dueAt <= endOfToday) buckets.today++;
    else if (t.dueAt <= endOfWeek) buckets.thisWeek++;
    else buckets.later++;
  }

  const rows = [
    { bucket: "Overdue", key: "overdue", count: buckets.overdue },
    { bucket: "Today", key: "today", count: buckets.today },
    { bucket: "This week", key: "thisWeek", count: buckets.thisWeek },
    { bucket: "Later", key: "later", count: buckets.later },
    { bucket: "No due date", key: "noDueDate", count: buckets.noDueDate },
  ];

  return NextResponse.json({ rows });
}
