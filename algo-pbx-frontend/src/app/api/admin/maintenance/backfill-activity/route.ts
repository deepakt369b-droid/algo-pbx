import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth-guard";
import { normalizeToE164 } from "@/lib/phone-normalize";
import { recordActivity, truncateBody } from "@/lib/crm/activity";

export const dynamic = "force-dynamic";

// POST /api/admin/maintenance/backfill-activity — one-time (idempotent, safe
// to re-run) backfill of the unified CRM timeline (S2) from historical
// CallDetailRecord + ChatMessage rows. Every future call/message writes its
// Activity row at ingest time (see api/cdr, lib/messaging/ingest,
// messages/route); this closes the gap for data that predates that.
//
// Idempotent via Activity's @@unique([type, refId]) — recordActivity() upserts
// on (type, refId), so a re-run only inserts rows that are genuinely missing.
// Best run after backfill-caller-e164 so CDR->contact matching is maximal.
export async function POST() {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const contacts = await db.contact.findMany({ select: { id: true, numberE164: true } });
  const byNumber = new Map(contacts.map((c) => [c.numberE164, c.id]));

  // ---- calls ----
  const cdrs = await db.callDetailRecord.findMany({
    select: {
      uniqueId: true,
      callerNumberE164: true,
      callerNumber: true,
      destination: true,
      direction: true,
      disposition: true,
      durationSec: true,
      startedAt: true,
      agentExtension: true,
    },
  });

  const extUsers = new Map(
    (
      await db.extension.findMany({ select: { number: true, userId: true } })
    ).map((e) => [e.number, e.userId]),
  );

  let calls = 0;
  for (const cdr of cdrs) {
    const e164 =
      cdr.callerNumberE164 ??
      normalizeToE164(cdr.callerNumber) ??
      normalizeToE164(cdr.destination);
    const contactId = e164 ? byNumber.get(e164) : undefined;
    if (!contactId) continue;
    const verb =
      cdr.disposition === "ANSWERED"
        ? cdr.direction === "inbound"
          ? "Inbound call"
          : "Outbound call"
        : `Call ${cdr.disposition.toLowerCase()}`;
    await recordActivity({
      type: "CALL",
      summary: `${verb}${cdr.durationSec ? ` · ${cdr.durationSec}s` : ""}`,
      refId: cdr.uniqueId,
      occurredAt: cdr.startedAt,
      contactId,
      actorId: cdr.agentExtension ? extUsers.get(cdr.agentExtension) ?? null : null,
    }, db);
    calls++;
  }

  // ---- messages ----
  const messages = await db.chatMessage.findMany({
    select: {
      id: true,
      direction: true,
      body: true,
      sensitive: true,
      createdAt: true,
      conversation: { select: { channel: true, contactId: true } },
    },
  });

  let msgs = 0;
  for (const m of messages) {
    if (!m.conversation.contactId) continue;
    const dir = m.direction === "OUTBOUND" ? "Sent" : "Received";
    const text = m.sensitive ? "(sensitive message)" : truncateBody(m.body, "(message)");
    await recordActivity({
      type: m.conversation.channel === "SMS" ? "SMS" : "WHATSAPP",
      summary: `${dir}: ${text}`,
      refId: m.id,
      occurredAt: m.createdAt,
      contactId: m.conversation.contactId,
    }, db);
    msgs++;
  }

  return NextResponse.json({
    scannedCalls: cdrs.length,
    scannedMessages: messages.length,
    callActivitiesWritten: calls,
    messageActivitiesWritten: msgs,
  });
}
