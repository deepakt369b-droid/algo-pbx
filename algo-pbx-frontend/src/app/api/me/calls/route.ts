import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";
import { buildContactDisplayMap, resolveContactDisplayName } from "@/lib/contact-display";
import { normalizeToE164 } from "@/lib/phone-normalize";

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
    db.contact.findMany({ select: { id: true, numberE164: true, displayName: true } }),
  ]);
  const contactsByE164 = buildContactDisplayMap(contacts);
  // CRM deep-link (LLM.md §31) — a local id map, not added to the shared
  // contact-display.ts helper (its resolveContactDisplayName() return
  // contract is a display string, read by 3+ routes; changing its shape
  // for one new caller here isn't worth the churn).
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
  });
}
