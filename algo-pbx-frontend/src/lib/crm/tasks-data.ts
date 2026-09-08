import type { Prisma } from "@prisma/client";
import type { TenantClient } from "@/lib/db-tenant";
import { recordActivity } from "@/lib/crm/activity";
import type { NormalizedTaskInput } from "@/lib/crm/task-input";

export type TaskFilter = "open" | "today" | "overdue" | "completed" | "all";

export type CrmTaskDto = {
  id: string;
  title: string;
  description: string | null;
  dueAt: string | null;
  completedAt: string | null;
  createdAt: string;
  assignee: { id: string; name: string | null } | null;
  contact: { id: string; displayName: string | null; numberE164: string } | null;
  deal: { id: string; name: string } | null;
};

// Wave 2a multi-tenant migration: takes a REQUIRED tenant-scoped
// `db: TenantClient` (src/lib/db-tenant.ts) instead of importing a
// module-level singleton — dependency injection per plan §2. Shared by the
// admin and agent task pages. `assigneeScope` null = staff (every task); a
// userId = that agent's own tasks only.
export async function loadTasks(
  db: TenantClient,
  opts: {
    filter: TaskFilter;
    assigneeScope: string | null;
    contactId?: string | null;
    dealId?: string | null;
  }
): Promise<CrmTaskDto[]> {
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
    description: t.description,
    dueAt: t.dueAt ? t.dueAt.toISOString() : null,
    completedAt: t.completedAt ? t.completedAt.toISOString() : null,
    createdAt: t.createdAt.toISOString(),
    assignee: t.assignee,
    contact: t.contact,
    deal: t.deal,
  }));
}

// New task creation (owner-page enchanted-sphinx plan, W4 — the task board
// previously had no create path at all). Mirrors crm/deals.ts's
// createDeal(): DI'd TenantClient, no `tenantId` in the create data (the
// extension force-injects it), and a matching Activity row so the task
// shows up on the contact's/deal's unified timeline.
export async function createTask(
  db: TenantClient,
  input: NormalizedTaskInput,
  callerId: string
): Promise<CrmTaskDto> {
  const task = await db.contactTask.create({
    data: {
      title: input.title,
      description: input.description,
      contactId: input.contactId,
      assigneeId: input.assigneeId ?? callerId,
      dealId: input.dealId,
      dueAt: input.dueAt,
    } as unknown as Prisma.ContactTaskUncheckedCreateInput,
    include: {
      assignee: { select: { id: true, name: true } },
      contact: { select: { id: true, displayName: true, numberE164: true } },
      deal: { select: { id: true, name: true } },
    },
  });

  await recordActivity(
    {
      type: "TASK",
      summary: `Task: ${task.title}`,
      refId: task.id,
      contactId: task.contactId,
      dealId: task.dealId,
      actorId: callerId,
    },
    db
  );

  return {
    id: task.id,
    title: task.title,
    description: task.description,
    dueAt: task.dueAt ? task.dueAt.toISOString() : null,
    completedAt: task.completedAt ? task.completedAt.toISOString() : null,
    createdAt: task.createdAt.toISOString(),
    assignee: task.assignee,
    contact: task.contact,
    deal: task.deal,
  };
}
