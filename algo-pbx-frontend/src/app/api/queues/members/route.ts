import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAmiClient } from "@/lib/ami-client";
import { requireStaffSession } from "@/lib/auth-guard";
import { addQueueMember, removeQueueMember, pauseQueueMember } from "@/lib/queue-membership";

export const dynamic = "force-dynamic";

// POST /api/queues/members — live membership mutations for the queue
// manager UI, closing the "Queue & Ring Group Manager manages nothing" gap.
// All three actions go through src/lib/queue-membership.ts's AMI helpers
// (the same ones user provisioning already uses), so there is exactly one
// path to Asterisk for membership changes.
//
// Note on persistence: queues.conf sets persistentmembers=yes, so AMI
// QueueAdd survives an Asterisk restart via AstDB; reconcileQueueMembership
// covers the opposite drift direction (extension provisioned while Asterisk
// was down). A remove here is intentionally NOT persisted to Postgres —
// Postgres's QueueMember rows are the provisioning-time expectation, this
// endpoint is the operator's live override (e.g. pulling a misbehaving
// agent out of rotation without deleting their account).
const Schema = z.object({
  queue: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  extension: z.string().regex(/^\d{3,6}$/),
  action: z.enum(["add", "remove", "pause", "unpause"]),
});

export async function POST(request: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { session, db } = guard;

  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const { queue, extension, action } = parsed.data;

  // Only mutate queues we actually own — a typo'd queue name would
  // otherwise make Asterisk reject it anyway, but failing fast here gives
  // the UI a clean error instead of a raw AMI failure. Queue.name was
  // globally @unique; it's tenant-composite now (`@@unique([tenantId,
  // name])`, plan §1), hence the compound key.
  const known = await db.queue.findUnique({ where: { tenantId_name: { tenantId: session.user.tenantId, name: queue } } });
  if (!known) {
    return NextResponse.json({ error: `Unknown queue: ${queue}` }, { status: 404 });
  }

  const ami = getAmiClient();
  try {
    switch (action) {
      case "add":
        await addQueueMember(ami, extension, queue);
        break;
      case "remove":
        await removeQueueMember(ami, extension, queue);
        break;
      case "pause":
        await pauseQueueMember(ami, extension, true, queue);
        break;
      case "unpause":
        await pauseQueueMember(ami, extension, false, queue);
        break;
    }
  } catch {
    return NextResponse.json({ error: "Asterisk AMI unreachable or action failed." }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}
