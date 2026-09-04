import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireStaffSession } from "@/lib/auth-guard";
import { loadTasks, type TaskFilter } from "@/lib/crm/tasks-data";

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
