import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireStaffSession } from "@/lib/auth-guard";
import { loadTasks, createTask, type TaskFilter } from "@/lib/crm/tasks-data";
import { TaskCreateSchema, normalizeTaskInput } from "@/lib/crm/task-input";

export const dynamic = "force-dynamic";

const FILTERS: TaskFilter[] = ["open", "today", "overdue", "completed", "all"];

export async function GET(request: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const sp = new URL(request.url).searchParams;
  const filter = (sp.get("filter") ?? "open") as TaskFilter;
  const tasks = await loadTasks(guard.db, {
    filter: FILTERS.includes(filter) ? filter : "open",
    assigneeScope: null,
    contactId: sp.get("contactId"),
    dealId: sp.get("dealId"),
  });
  return NextResponse.json({ tasks });
}

// POST /api/admin/crm/tasks — task creation (this route previously had only
// GET + PATCH; the task board had no create path at all — owner-page
// enchanted-sphinx plan, W4). Contact stays REQUIRED per the confirmed
// decision; every id is resolved through the tenant-scoped `db` before
// writing so a cross-tenant id 404s instead of silently succeeding.
export async function POST(request: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db, session } = guard;

  const parsed = TaskCreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const normalized = normalizeTaskInput(parsed.data);
  if (!normalized.ok) {
    return NextResponse.json({ error: normalized.error }, { status: 400 });
  }
  const input = normalized.value;

  const contact = await db.contact.findUnique({ where: { id: input.contactId }, select: { id: true } });
  if (!contact) return NextResponse.json({ error: "Contact not found." }, { status: 404 });

  if (input.assigneeId) {
    const assignee = await db.user.findUnique({ where: { id: input.assigneeId }, select: { id: true } });
    if (!assignee) return NextResponse.json({ error: "Assignee not found." }, { status: 404 });
  }
  if (input.dealId) {
    const deal = await db.deal.findUnique({ where: { id: input.dealId }, select: { id: true } });
    if (!deal) return NextResponse.json({ error: "Deal not found." }, { status: 404 });
  }

  const task = await createTask(db, input, session.user.id);
  return NextResponse.json({ task }, { status: 201 });
}

const PatchSchema = z.object({ taskId: z.string(), completed: z.boolean() });

export async function PATCH(request: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;
  const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }
  const task = await db.contactTask.update({
    where: { id: parsed.data.taskId },
    data: { completedAt: parsed.data.completed ? new Date() : null },
  });
  return NextResponse.json({ task });
}
