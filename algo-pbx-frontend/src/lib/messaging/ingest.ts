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

/** A media message's caption is worth keeping; the raw base64 blob (which
 * some engines put in `body`) is not, and never reaches here — the provider
 * mapper drops it. This just picks the human-readable summary for the CRM
 * timeline and the conversation-list preview. */
function mediaSummary(kind: string | null | undefined, body: string | null): string {
  const caption = body?.trim();
  if (caption) return caption;
  switch (kind) {
    case "voice":
      return "🎤 Voice message";
    case "audio":
      return "🎵 Audio";
    case "image":
      return "📷 Photo";
    case "video":
      return "🎬 Video";
    case "document":
      return "📄 Document";
    case "sticker":
      return "Sticker";
    default:
      return "(attachment)";
  }
}

/**
 * The core persist step shared by the inbound webhook path and history-sync.
 * Idempotent on `waMessageId` (also `providerMessageId`) — a message seen by
 * both the live webhook and a later backlog pull is written once.
 *
 * `opts.bumpUnread` / `opts.emit` are true only on the live inbound path;
 * history-sync passes false so a backfill doesn't light up every badge or
 * re-fire CRM webhooks for months-old messages.
 *
 * Returns the ChatMessage row id, or null if it was a duplicate / not
 * attributable to a contact.
 */
export async function persistNormalizedMessage(
  event: NormalizedInboundEvent,
  channel: Channel,
  waInstanceId: string | null,
  opts: { bumpUnread?: boolean; emit?: boolean } = {}
): Promise<string | null> {
  if (!event.fromE164) return null;
  const outbound = event.direction === "outgoing";

  // Dedupe before doing any writes.
  const dedupeKeys: Prisma.ChatMessageWhereInput[] = [];
  if (event.waMessageId) dedupeKeys.push({ waMessageId: event.waMessageId });
  if (event.providerMessageId) dedupeKeys.push({ providerMessageId: event.providerMessageId });
  if (dedupeKeys.length) {
    const seen = await db.chatMessage.findFirst({ where: { OR: dedupeKeys }, select: { id: true } });
    if (seen) return null;
  }

  const contact = await db.contact.upsert({
    where: { numberE164: event.fromE164 },
    update: {},
    create: {
      numberE164: event.fromE164,
      displayName: event.contactName ?? undefined,
    },
  });
  // Adopt the provider's name only when we still have none (an outgoing
  // message's chatName is the account owner, so mapOpenWaMessage only sets
  // contactName for incoming — no extra guard needed here).
  if (event.contactName && !contact.displayName) {
    await db.contact
      .update({ where: { id: contact.id }, data: { displayName: event.contactName } })
      .catch(() => undefined);
  }

  const when = event.timestamp ?? new Date();
  const { conversation: found, created } = await findOrCreateConversation(contact.id, channel, waInstanceId, {
    lastMessageAt: when,
    unreadCount: outbound || !opts.bumpUnread ? 0 : 1,
  });
  const conversation =
    created
      ? found
      : await db.conversation.update({
          where: { id: found.id },
          data: {
            // Only advance lastMessageAt forward.
            ...(found.lastMessageAt && found.lastMessageAt >= when ? {} : { lastMessageAt: when }),
            ...(outbound || !opts.bumpUnread ? {} : { unreadCount: { increment: 1 } }),
          },
        });

  const sensitive = channel === "SMS" && !event.mediaKind && event.body ? isSensitiveSms(event.body) : false;

  const message = await db.chatMessage.create({
    data: {
      conversationId: conversation.id,
      direction: outbound ? "OUTBOUND" : "INBOUND",
      body: event.mediaKind ? (event.body?.trim() || null) : event.body,
      mediaKind: event.mediaKind ?? null,
      mediaMimeType: event.mediaMimeType ?? null,
      providerMessageId: event.providerMessageId ?? null,
      waMessageId: event.waMessageId ?? null,
      deliveryStatus: event.deliveryStatus ?? (outbound ? "sent" : "delivered"),
      sensitive,
      createdAt: when,
    },
  });

  // A media message's bytes live in OpenWA; the browser fetches them through
  // our auth-checked proxy keyed by this row id.
  if (event.mediaKind) {
    await db.chatMessage
      .update({ where: { id: message.id }, data: { mediaUrl: `/api/messaging/media/${message.id}` } })
      .catch(() => undefined);
  }

  await recordActivity({
    type: channel === "SMS" ? "SMS" : "WHATSAPP",
    summary: `${outbound ? "Sent" : "Received"}: ${
      sensitive
        ? "(sensitive message)"
        : event.mediaKind
          ? mediaSummary(event.mediaKind, event.body)
          : truncateBody(event.body, "(message)")
    }`,
    refId: message.id,
    occurredAt: message.createdAt,
    contactId: contact.id,
  });

  if (opts.emit && !outbound) {
    void emitEvent("message.received", {
      conversationId: conversation.id,
      channel,
      fromE164: event.fromE164,
      body: sensitive ? null : message.body ?? mediaSummary(event.mediaKind, null),
      sensitive,
    });
  }

  return message.id;
}

// Shared inbound-message ingestion path — every provider's webhook/poll
// route calls this. Thin wrapper over persistNormalizedMessage with the
// live-inbound flags on.
export async function ingestInboundEvent(
  event: NormalizedInboundEvent,
  channel: Channel,
  waInstanceId: string | null
): Promise<void> {
  await persistNormalizedMessage(event, channel, waInstanceId, { bumpUnread: true, emit: true });
}
