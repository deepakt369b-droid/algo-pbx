import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// GET /api/agent/crm/call-context/latest-call — node W (W3) helper.
//
// sip-context.tsx exposes NO call/unique id (verified: SIPContextType has
// callState/incomingCallerId/makeCall… and nothing that identifies the
// call — plan G3). So after a call ends, DispositionPrompt cannot know
// which CDR row to attach the disposition to from SIP state. This resolves
// it the only way available: the most recent CallDetailRecord for the
// agent's own extension. GET /api/me/calls does the same resolution but
// doesn't expose uniqueId in its projection, and it isn't this node's file
// to change — this tiny read-only sibling returns exactly what
// CallDisposition.cdrUniqueId needs.
export async function GET() {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;

  const extension = guard.session.user.extension;
  if (!extension) return NextResponse.json({ call: null });

  const call = await db.callDetailRecord.findFirst({
    where: { agentExtension: extension },
    orderBy: { startedAt: "desc" },
    select: { uniqueId: true, callerNumber: true, direction: true, startedAt: true, durationSec: true },
  });

  return NextResponse.json({ call });
}
