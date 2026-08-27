import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";
import { canAccessRecording } from "@/lib/recording-access";

export const dynamic = "force-dynamic";

// POST /api/recordings/hide { id } — Phase D. Stamps hiddenFromAgentAt;
// NEVER calls db.recording.delete. This is the ONLY agent-reachable
// mutation on a Recording — matches the requirement verbatim ("agent side
// deletion will not delete the recording"). Hard delete lives in a
// completely separate, ADMIN-only route
// (src/app/api/admin/recordings/[id]/route.ts) so the two code paths can
// never be confused with each other.
//
// Takes `id` in the JSON body rather than a `/api/recordings/[id]/hide` URL
// segment — Next.js requires every dynamic segment at the same path
// position to share one param name across sibling routes, and this would
// otherwise collide with the byte-serving `/api/recordings/[uniqueid]`
// route (a different identifier entirely: CDR uniqueId, not Recording.id).
// Caught by `next build` failing outright, not a style preference.
// `hidden` defaults true (the agent "Hide" action). Staff can pass
// `hidden: false` to un-hide from the new /admin/recordings page — an
// agent can only ever hide, never reveal (canAccessRecording() denies
// them a hidden recording, so they can't target it to un-hide anyway).
const HideSchema = z.object({ id: z.string(), hidden: z.boolean().default(true) });

export async function POST(req: NextRequest) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { session } = guard;

  const body = await req.json();
  const parsed = HideSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const recording = await db.recording.findUnique({
    where: { id: parsed.data.id },
    include: { cdr: { select: { agentExtension: true } } },
  });
  if (!recording) {
    return NextResponse.json({ error: "Recording not found" }, { status: 404 });
  }

  const isStaff = session.user.role === "ADMIN" || session.user.role === "SUPERVISOR";

  // Un-hide is staff-only. An agent can only ever hide.
  if (parsed.data.hidden === false && !isStaff) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (parsed.data.hidden) {
    const allowed = canAccessRecording({
      role: session.user.role,
      callerExtension: session.user.extension,
      cdrAgentExtension: recording.cdr.agentExtension,
      hiddenFromAgentAt: recording.hiddenFromAgentAt,
    });
    if (!allowed) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const updated = await db.recording.update({
    where: { id: parsed.data.id },
    data: parsed.data.hidden
      ? { hiddenFromAgentAt: new Date(), hiddenByUserId: session.user.id }
      : { hiddenFromAgentAt: null, hiddenByUserId: null },
  });

  await db.auditLog.create({
    data: {
      action: parsed.data.hidden ? "recording.hide" : "recording.unhide",
      actorId: session.user.id,
      targetId: recording.id,
    },
  });

  return NextResponse.json({ recording: updated });
}
