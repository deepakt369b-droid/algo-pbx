import { db } from "@/lib/db";
import { emitEvent } from "@/lib/emit-event";
import { isSensitiveSms } from "./sensitive-detect";
import type { Channel, NormalizedInboundEvent } from "./types";

// Shared inbound-message ingestion path — every provider's webhook/poll
// route calls this, so "upsert Contact -> upsert Conversation -> create
// ChatMessage -> bump unreadCount/lastMessageAt -> classify sensitivity"
// only has one implementation. Kept out of the route handlers themselves
// so the OpenWA webhook, the Meta webhook, and the Dinstar poll route are
// each a thin adapter-specific parse step feeding this one function.
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

  // Prisma 5's extendedWhereUnique (GA, no preview flag needed) allows null
  // directly in a compound-unique `where` — but Postgres itself treats
  // NULL as distinct from every other NULL for uniqueness purposes, so the
  // @@unique([contactId, channel, waInstanceId]) constraint in
  // schema.prisma would NOT stop two SMS conversations (waInstanceId
  // always null, since Dinstar has no per-instance session) for the same
  // contact from being created by a race between two concurrent inbound
  // polls. Look the row up explicitly first rather than trusting upsert's
  // atomicity here; a lost race just means one extra harmless duplicate
  // conversation in the rare concurrent-first-message case, not a
  // constraint violation.
  const existing = await db.conversation.findFirst({
    where: { contactId: contact.id, channel, waInstanceId },
  });
  const conversation = existing
    ? await db.conversation.update({
        where: { id: existing.id },
        data: { lastMessageAt: event.timestamp ?? new Date(), unreadCount: { increment: 1 } },
      })
    : await db.conversation.create({
        data: {
          contactId: contact.id,
          channel,
          waInstanceId,
          lastMessageAt: event.timestamp ?? new Date(),
          unreadCount: 1,
        },
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
