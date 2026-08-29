import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";
import { buildContactDisplayMap, resolveContactDisplayName } from "@/lib/contact-display";

export const dynamic = "force-dynamic";

// GET /api/me/calls — an agent's own recent call history. Before this
// route existed, there was NO call-log view anywhere in the agent UI at
// all (reported live 2026-08-29) — only /agent/missed, which shows a
// narrower, differently-filtered slice (see that route's comment). This is
// deliberately the own-extension-scoped sibling of GET /api/cdr, which is
// requireStaffSession()-guarded and so unusable by an AGENT directly.
//
// Every row this returns depends on CallDetailRecord.agentExtension being
// populated, which was a real, separately-fixed bug (src/lib/cdr-mapper.ts,
// 2026-08-29) — confirmed against live production rows that it was NULL on
// 100% of calls before that fix. A call placed before the fix deployed will
// never appear here regardless of this route's own correctness.
const LIMIT = 50;

export async function GET() {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { session } = guard;

  const extension = session.user.extension;
  if (!extension) {
    return NextResponse.json({ error: "No extension linked to this account" }, { status: 404 });
  }

  const [calls, contacts] = await Promise.all([
    db.callDetailRecord.findMany({
      where: { agentExtension: extension },
      orderBy: { startedAt: "desc" },
      take: LIMIT,
      select: {
        id: true,
        callerNumber: true,
        destination: true,
        direction: true,
        disposition: true,
        startedAt: true,
        billsecSec: true,
        recordingUrl: true,
      },
    }),
    // Same best-effort name resolution GET /api/cdr and GET
    // /api/me/missed-calls already do — CallDetailRecord.callerNumber has
    // no FK to Contact, it's a raw string off an Asterisk CDR event.
    db.contact.findMany({ select: { numberE164: true, displayName: true } }),
  ]);
  const contactsByE164 = buildContactDisplayMap(contacts);

  return NextResponse.json({
    calls: calls.map((call) => ({
      ...call,
      callerDisplayName: resolveContactDisplayName(call.callerNumber, contactsByE164),
    })),
  });
}
