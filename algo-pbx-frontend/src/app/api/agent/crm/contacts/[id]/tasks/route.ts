import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";
import { canWriteContact } from "@/lib/contact-ownership";
import { recordActivity } from "@/lib/crm/activity";

export const dynamic = "force-dynamic";

const CreateSchema = z.object({
  title: z.string().min(1).max(300),
  dueAt: z.coerce.date().optional(),
  // Defaults to the creating agent — an agent assigning a task to someone
  // else is allowed (e.g. handing a callback to a colleague) but the
  // common case (self-assign) needs no extra field.
  assigneeId: z.string().optional(),
});

// Feature B2 (2026-08-31) — same conflict-prevention enforcement as notes/
// route.ts: a non-owner may not add/complete tasks on an OWNED contact.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { role, id: userId } = guard.session.user;

  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const contact = await db.contact.findUnique({ where: { id: params.id }, include: { owner: { select: { name: true } } } });
  if (!contact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!canWriteContact({ role: role as "AGENT" | "SUPERVISOR" | "ADMIN", userId, ownerId: contact.ownerId })) {
    return NextResponse.json(
      { error: `This contact is owned by ${contact.owner?.name ?? "another agent"}. Request a transfer to edit it.` },
      { status: 403 }
    );
  }

  const task = await db.contactTask.create({
    data: {
      contactId: contact.id,
      assigneeId: parsed.data.assigneeId ?? guard.session.user.id,
      title: parsed.data.title,
      dueAt: parsed.data.dueAt,
    },
    include: { assignee: { select: { id: true, name: true } } },
  });

  await recordActivity({
    type: "TASK",
    summary: `Task: ${parsed.data.title.slice(0, 140)}`,
    refId: task.id,
    contactId: contact.id,
    actorId: guard.session.user.id,
  });

  return NextResponse.json({ task }, { status: 201 });
}

const PatchSchema = z.object({
  taskId: z.string(),
  completed: z.boolean(),
});

// PATCH — toggle a task's completed state. Lives on the collection route
// (not /tasks/[taskId]) since the only mutation this surface needs today
// is the complete/reopen toggle; a dedicated sub-resource route would be
// pure ceremony for one field.
export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { role, id: userId } = guard.session.user;

  const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const existing = await db.contactTask.findUnique({
    where: { id: parsed.data.taskId },
    include: { contact: { include: { owner: { select: { name: true } } } } },
  });
  if (!existing || existing.contactId !== params.id) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!canWriteContact({ role: role as "AGENT" | "SUPERVISOR" | "ADMIN", userId, ownerId: existing.contact.ownerId })) {
    return NextResponse.json(
      { error: `This contact is owned by ${existing.contact.owner?.name ?? "another agent"}. Request a transfer to edit it.` },
      { status: 403 }
    );
  }

  const task = await db.contactTask.update({
    where: { id: parsed.data.taskId },
    data: { completedAt: parsed.data.completed ? new Date() : null },
    include: { assignee: { select: { id: true, name: true } } },
  });

  return NextResponse.json({ task });
}
