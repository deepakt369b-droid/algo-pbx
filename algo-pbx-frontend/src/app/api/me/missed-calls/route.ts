import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";
import { buildContactDisplayMap, resolveContactDisplayName } from "@/lib/contact-display";
import { normalizeToE164 } from "@/lib/phone-normalize";

export const dynamic = "force-dynamic";

// GET /api/me/missed-calls — derived entirely from CallDetailRecord, no
// new call-log table. Before this route existed, an agent who stepped
// away had no way to see who had called: agentExtension/disposition were
// already on every CDR row but nothing ever surfaced them back to the
// agent who owned the extension. Own-extension-only, same ownership rule
// GET /api/voicemail already uses for AGENT sessions.
//
// "Missed" here means inbound + not actually connected to this agent — an
// outbound call that failed isn't a call the caller experienced as
// unanswered by this agent, so it's deliberately excluded.
//
// NOT a disposition-string match (`NO ANSWER`/`BUSY`/`FAILED`) — confirmed
// live 2026-08-29 that `[from-dinstar]` calls `Answer()`
// (pbx_configs/extensions.conf) BEFORE `Queue(support_queue,...)`, so a
// call that rang and nobody picked up is recorded `ANSWERED` at the
// Asterisk CDR level regardless of whether any agent ever spoke. The only
// signal that actually distinguishes "an agent talked to this caller" is
// billable seconds: `billsecSec === 0` (equivalently `answeredAt: null`)
// means the queue leg to an agent's phone never connected, independent of
// what disposition string Asterisk chose to write.
const LIMIT = 50;

export async function GET() {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { session } = guard;

  const extension = session.user.extension;
  if (!extension) {
    return NextResponse.json({ error: "No extension linked to this account" }, { status: 404 });
  }

  const [calls, user, contacts] = await Promise.all([
    db.callDetailRecord.findMany({
      where: { agentExtension: extension, direction: "inbound", billsecSec: 0 },
      orderBy: { startedAt: "desc" },
      take: LIMIT,
      select: { id: true, callerNumber: true, startedAt: true, disposition: true },
    }),
    db.user.findUnique({ where: { id: session.user.id }, select: { missedCallsSeenAt: true } }),
    // Same best-effort name resolution GET /api/cdr already does (see
    // that route's comment) — CallDetailRecord.callerNumber has no FK to
    // Contact, it's a raw string off an Asterisk CDR event. This route
    // previously showed only the raw number here while the admin CDR page
    // already resolved names for the exact same data; agents deserve the
    // same readability the admin view has.
    db.contact.findMany({ select: { id: true, numberE164: true, displayName: true } }),
  ]);
  const contactsByE164 = buildContactDisplayMap(contacts);
  // CRM deep-link (LLM.md §31) — see /api/me/calls's identical comment on
  // why this is a local map rather than a contact-display.ts change.
  const contactIdByE164 = new Map(contacts.map((c) => [c.numberE164, c.id]));

  return NextResponse.json({
    calls: calls.map((call) => {
      const normalized = normalizeToE164(call.callerNumber);
      return {
        ...call,
        callerDisplayName: resolveContactDisplayName(call.callerNumber, contactsByE164),
        callerContactId: normalized ? (contactIdByE164.get(normalized) ?? null) : null,
      };
    }),
    lastSeenAt: user?.missedCallsSeenAt ?? null,
  });
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
