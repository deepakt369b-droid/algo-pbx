import { db } from "@/lib/db";
import { emitEvent } from "@/lib/emit-event";
import { isSensitiveSms } from "./sensitive-detect";
import { recordActivity, truncateBody } from "@/lib/crm/activity";
import type { Channel, NormalizedInboundEvent } from "./types";
import type { Conversation, Prisma } from "@prisma/client";

// Prisma 5's extendedWhereUnique (GA, no preview flag needed) allows null
// directly in a compound-unique `where` — but Postgres itself treats NULL
// as distinct from every other NULL for uniqueness purposes, so the
// @@unique([contactId, channel, waInstanceId]) constraint in
// schema.prisma would NOT stop two conversations with waInstanceId: null
// (e.g. SMS, since Dinstar has no per-instance session, or a race between
// two concurrent callers) for the same contact+channel from being created.
// Look the row up explicitly first rather than trusting upsert's atomicity
// here; a lost race just means one extra harmless duplicate conversation
// in the rare concurrent-first-message case, not a constraint violation.
//
// Shared by ingestInboundEvent() below (inbound webhook/poll path) and
// POST /api/messaging/conversations (agent-initiated new-conversation
// path) so the two can't drift into different dedupe behavior.
// `createData` supplies fields to set only when a new row is created
// (e.g. lastMessageAt/unreadCount for an inbound message, assignedAgentId
// for an agent-started one) — never applied to an existing row.
export async function findOrCreateConversation(
  contactId: string,
  channel: Channel,
  waInstanceId: string | null,
  createData: Partial<Prisma.ConversationUncheckedCreateInput> = {}
): Promise<{ conversation: Conversation; created: boolean }> {
  const existing = await db.conversation.findFirst({
    where: { contactId, channel, waInstanceId },
  });
  if (existing) return { conversation: existing, created: false };

  const conversation = await db.conversation.create({
    data: { contactId, channel, waInstanceId, ...createData },
  });
  return { conversation, created: true };
}

// Shared inbound-message ingestion path — every provider's webhook/poll
// route calls this, so "upsert Contact -> find-or-create Conversation ->
// create ChatMessage -> bump unreadCount/lastMessageAt -> classify
// sensitivity" only has one implementation. Kept out of the route handlers
// themselves so the OpenWA webhook, the Meta webhook, and the Dinstar poll
// route are each a thin adapter-specific parse step feeding this one
// function.
export async function ingestInboundEvent(
  event: NormalizedInboundEvent,
  channel: Channel,
  waInstanceId: string | null
): Promise<void> {
  if (!event.fromE164) return;

  const contact = await db.contact.upsert({
    where: { numberE164: event.fromE164 },
    update: {},
    create: { numberE164: event.fromE164 },
  });

  const { conversation: found, created } = await findOrCreateConversation(
    contact.id,
    channel,
    waInstanceId,
    { lastMessageAt: event.timestamp ?? new Date(), unreadCount: 1 }
  );
  const conversation = created
    ? found
    : await db.conversation.update({
        where: { id: found.id },
        data: { lastMessageAt: event.timestamp ?? new Date(), unreadCount: { increment: 1 } },
      });

  const sensitive = channel === "SMS" && event.body ? isSensitiveSms(event.body) : false;

  const message = await db.chatMessage.create({
    data: {
      conversationId: conversation.id,
      direction: "INBOUND",
      body: event.body,
      mediaUrl: event.mediaUrl ?? null,
      mediaMimeType: event.mediaMimeType ?? null,
      providerMessageId: event.providerMessageId ?? null,
      deliveryStatus: "delivered",
      sensitive,
    },
  });

  // Unified CRM timeline (S2). A sensitive body is redacted here too — the
  // summary must never leak an OTP.
  await recordActivity({
    type: channel === "SMS" ? "SMS" : "WHATSAPP",
    summary: `Received: ${sensitive ? "(sensitive message)" : truncateBody(event.body, "(message)")}`,
    refId: message.id,
    occurredAt: message.createdAt,
    contactId: contact.id,
  });

  // Not awaited — a slow/down CRM webhook endpoint must never add latency
  // to inbound message ingestion. Sensitive bodies are never included, per
  // the same server-side redaction rule the agent-facing routes enforce
  // (see src/lib/messaging/conversation-access.ts).
  void emitEvent("message.received", {
    conversationId: conversation.id,
    channel,
    fromE164: event.fromE164,
    body: sensitive ? null : message.body,
    sensitive,
  });
}
