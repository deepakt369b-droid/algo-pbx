import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

export type TaskFilter = "open" | "today" | "overdue" | "completed" | "all";

export type CrmTaskDto = {
  id: string;
  title: string;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
  assignee: { id: string; name: string | null } | null;
  contact: { id: string; displayName: string | null; numberE164: string } | null;
  deal: { id: string; name: string } | null;
};

// Shared by the admin and agent task pages. `assigneeScope` null = staff
// (every task); a userId = that agent's own tasks only.
export async function loadTasks(opts: {
  filter: TaskFilter;
  assigneeScope: string | null;
  contactId?: string | null;
  dealId?: string | null;
}): Promise<CrmTaskDto[]> {
  const now = new Date();
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);

  const clauses: Prisma.ContactTaskWhereInput[] = [];
  if (opts.assigneeScope) clauses.push({ assigneeId: opts.assigneeScope });
  if (opts.contactId) clauses.push({ contactId: opts.contactId });
  if (opts.dealId) clauses.push({ dealId: opts.dealId });

  switch (opts.filter) {
    case "completed":
      clauses.push({ completedAt: { not: null } });
      break;
    case "overdue":
      clauses.push({ completedAt: null, dueAt: { lt: now } });
      break;
    case "today":
      clauses.push({ completedAt: null, dueAt: { gte: now, lte: endOfToday } });
      break;
    case "open":
      clauses.push({ completedAt: null });
      break;
    case "all":
    default:
      break;
  }

  const rows = await db.contactTask.findMany({
    where: clauses.length ? { AND: clauses } : {},
    orderBy: [{ completedAt: "asc" }, { dueAt: "asc" }, { createdAt: "desc" }],
    take: 300,
    include: {
      assignee: { select: { id: true, name: true } },
      contact: { select: { id: true, displayName: true, numberE164: true } },
      deal: { select: { id: true, name: true } },
    },
  });

  return rows.map((t) => ({
    id: t.id,
    title: t.title,
    dueAt: t.dueAt ? t.dueAt.toISOString() : null,
    completedAt: t.completedAt ? t.completedAt.toISOString() : null,
    createdAt: t.createdAt.toISOString(),
    assignee: t.assignee,
    contact: t.contact,
    deal: t.deal,
  }));
}
