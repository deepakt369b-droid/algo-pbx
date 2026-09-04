import { NextRequest, NextResponse } from "next/server";
import { requireApiKey } from "@/lib/api-key-auth";
import { checkSimpleRateLimit } from "@/lib/rate-limit";
import { normalizeToE164 } from "@/lib/phone-normalize";

export const dynamic = "force-dynamic";

// GET /api/crm/contacts/[id]/activity — a merged timeline of this contact's
// calls (CallDetailRecord) and chat messages (Conversation/ChatMessage),
// for an external CRM to render on a contact's page. CDR caller/destination
// numbers are NOT pre-normalized in this schema (see prisma/schema.prisma's
// CallDetailRecord comment) — matched here by normalizing on read rather
// than trusting stored formatting to line up with Contact.numberE164.
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireApiKey(request);
  if ("response" in guard) return guard.response;
  const { db } = guard;
  if (!checkSimpleRateLimit(`crm:${guard.apiKey.id}`, 120, 60_000)) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const contact = await db.contact.findUnique({ where: { id: params.id } });
  if (!contact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // CDR numbers aren't stored normalized, so pull a reasonably broad
  // recent window and filter in-process by normalizing each row — cheaper
  // to reason about correctly than a fragile SQL LIKE against varying
  // formats, and CDR volume for one contact is small.
  const recentCdrs = await db.callDetailRecord.findMany({
    orderBy: { startedAt: "desc" },
    take: 2000,
  });
  const matchingCdrs = recentCdrs
    .filter((c) => normalizeToE164(c.callerNumber) === contact.numberE164 || normalizeToE164(c.destination) === contact.numberE164)
    .slice(0, 100)
    .map((c) => ({
      type: "call" as const,
      timestamp: c.startedAt,
      uniqueId: c.uniqueId,
      direction: c.direction,
      disposition: c.disposition,
      durationSec: c.durationSec,
      agentExtension: c.agentExtension,
    }));

  const conversations = await db.conversation.findMany({ where: { contactId: contact.id } });
  const messages = await db.chatMessage.findMany({
    where: { conversationId: { in: conversations.map((c) => c.id) } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  const matchingMessages = messages
    // Never leak a sensitive (OTP-shaped) SMS body through the CRM API —
    // same rule as the agent-facing chat routes.
    .map((m) => ({
      type: "message" as const,
      timestamp: m.createdAt,
      channel: conversations.find((c) => c.id === m.conversationId)?.channel,
      direction: m.direction,
      body: m.sensitive ? null : m.body,
      sensitive: m.sensitive,
    }));

  const timeline = [...matchingCdrs, ...matchingMessages].sort(
    (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  return NextResponse.json({ contact, timeline });
}
