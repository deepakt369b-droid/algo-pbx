import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";
import { canWriteContact } from "@/lib/contact-ownership";
import { loadTasks, type TaskFilter } from "@/lib/crm/tasks-data";

export const dynamic = "force-dynamic";

const FILTERS: TaskFilter[] = ["open", "today", "overdue", "completed", "all"];

// GET /api/agent/crm/tasks — the agent task inbox. An AGENT sees only tasks
// assigned to them; staff see everything (oversight convention).
export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { role, id } = guard.session.user;

  const sp = new URL(request.url).searchParams;
  const filter = (sp.get("filter") ?? "open") as TaskFilter;
  const tasks = await loadTasks({
    filter: FILTERS.includes(filter) ? filter : "open",
    assigneeScope: role === "AGENT" ? id : null,
    contactId: sp.get("contactId"),
    dealId: sp.get("dealId"),
  });
  return NextResponse.json({ tasks });
}

const PatchSchema = z.object({ taskId: z.string(), completed: z.boolean() });

// PATCH — complete/reopen in place. Same conflict-prevention rule as the
// per-contact tasks route: a non-owner may not touch tasks on an OWNED
// contact.
export async function PATCH(request: NextRequest) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { role, id: userId } = guard.session.user;

  const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const existing = await db.contactTask.findUnique({
    where: { id: parsed.data.taskId },
    include: { contact: { include: { owner: { select: { name: true } } } } },
  });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const isAssignee = existing.assigneeId === userId;
  if (
    !isAssignee &&
    !canWriteContact({ role: role as "AGENT" | "SUPERVISOR" | "ADMIN", userId, ownerId: existing.contact.ownerId })
  ) {
    return NextResponse.json(
      { error: `This contact is owned by ${existing.contact.owner?.name ?? "another agent"}.` },
      { status: 403 },
    );
  }

  const task = await db.contactTask.update({
    where: { id: parsed.data.taskId },
    data: { completedAt: parsed.data.completed ? new Date() : null },
  });
  return NextResponse.json({ task });
}
