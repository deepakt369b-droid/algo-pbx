import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// GET /api/me/missed-calls — derived entirely from CallDetailRecord, no
// new call-log table. Before this route existed, an agent who stepped
// away had no way to see who had called: agentExtension/disposition were
// already on every CDR row but nothing ever surfaced them back to the
// agent who owned the extension. Own-extension-only, same ownership rule
// GET /api/voicemail already uses for AGENT sessions.
//
// "Missed" here means inbound + not answered — an outbound call that
// failed isn't a call the caller experienced as unanswered by this agent,
// so it's deliberately excluded.
const MISSED_DISPOSITIONS = ["NO ANSWER", "BUSY", "FAILED"];
const LIMIT = 50;

export async function GET() {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { session } = guard;

  const extension = session.user.extension;
  if (!extension) {
    return NextResponse.json({ error: "No extension linked to this account" }, { status: 404 });
  }

  const [calls, user] = await Promise.all([
    db.callDetailRecord.findMany({
      where: { agentExtension: extension, direction: "inbound", disposition: { in: MISSED_DISPOSITIONS } },
      orderBy: { startedAt: "desc" },
      take: LIMIT,
      select: { id: true, callerNumber: true, startedAt: true, disposition: true },
    }),
    db.user.findUnique({ where: { id: session.user.id }, select: { missedCallsSeenAt: true } }),
  ]);

  return NextResponse.json({ calls, lastSeenAt: user?.missedCallsSeenAt ?? null });
}

// Marks the agent's missed-call list as viewed — same lightweight
// same-route-POST pattern as /api/admin/sign-ins, not worth a separate
// endpoint for one field.
export async function POST() {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;

  await db.user.update({ where: { id: guard.session.user.id }, data: { missedCallsSeenAt: new Date() } });
  return NextResponse.json({ ok: true });
}
