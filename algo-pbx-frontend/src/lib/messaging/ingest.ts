import type { TenantClient } from "@/lib/db-tenant";
import { emitEvent } from "@/lib/emit-event";
import { isSensitiveSms } from "./sensitive-detect";
import { recordActivity, truncateBody } from "@/lib/crm/activity";
import type { Channel, NormalizedInboundEvent } from "./types";
import type { Conversation, Prisma } from "@prisma/client";

// Wave 2a multi-tenant migration: every export here takes a REQUIRED
// tenant-scoped `db: TenantClient` (src/lib/db-tenant.ts) as its first
// argument instead of importing a module-level singleton — dependency
// injection per plan §2, threaded through to emitEvent()/recordActivity()
// (both also DI'd, same wave). Every caller (the OpenWA webhook route, the
// SMS poll route, messaging/history-sync.ts) already has one from its own
// guard.

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
  db: TenantClient,
  contactId: string,
  channel: Channel,
  waInstanceId: string | null,
  createData: Partial<Prisma.ConversationUncheckedCreateInput> = {}
): Promise<{ conversation: Conversation; created: boolean }> {
  const existing = await db.conversation.findFirst({
    where: { contactId, channel, waInstanceId },
  });
  if (existing) return { conversation: existing, created: false };

  // No `tenantId` in this literal — the `TenantClient` extension
  // force-injects it at runtime regardless of what's passed (see
  // crm/activity.ts's comment on the same pattern); the double-cast below
  // satisfies the compiler about that runtime guarantee.
  const conversation = await db.conversation.create({
    data: { contactId, channel, waInstanceId, ...createData } as unknown as Prisma.ConversationUncheckedCreateInput,
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
  db: TenantClient,
  event: NormalizedInboundEvent,
  channel: Channel,
  waInstanceId: string | null,
  opts: { bumpUnread?: boolean; emit?: boolean } = {}
): Promise<string | null> {
  if (!event.fromE164) return null;
  const outbound = event.direction === "outgoing";

  // ~1.4 MB of base64 (~1 MB decoded). Voice notes and most photos fit;
  // bigger payloads keep mediaKind (so the bubble still shows) but the
  // proxy falls back to the sidecar's /media endpoint for them.
  const MAX_MEDIA_B64 = 1_400_000;
  const storedB64 =
    event.mediaBase64 && event.mediaBase64.length <= MAX_MEDIA_B64 ? event.mediaBase64 : null;

  // Dedupe before doing any writes — but if the row exists WITHOUT its media
  // bytes and this pass has them (e.g. a re-sync now running with
  // includeMedia), backfill just that.
  const dedupeKeys: Prisma.ChatMessageWhereInput[] = [];
  if (event.waMessageId) dedupeKeys.push({ waMessageId: event.waMessageId });
  if (event.providerMessageId) dedupeKeys.push({ providerMessageId: event.providerMessageId });
  if (dedupeKeys.length) {
    const seen = await db.chatMessage.findFirst({
      where: { OR: dedupeKeys },
      select: { id: true, mediaData: true, mediaKind: true, mediaMimeType: true },
    });
    if (seen) {
      if (seen.mediaKind && !seen.mediaData && storedB64) {
        await db.chatMessage
          .update({
            where: { id: seen.id },
            data: {
              mediaData: storedB64,
              mediaMimeType: seen.mediaMimeType ?? event.mediaMimeType ?? null,
              mediaUrl: `/api/messaging/media/${seen.id}`,
            },
          })
          .catch(() => undefined);
      }
      return null;
    }
  }

  // Contact.numberE164 was globally @unique; it's tenant-composite now
  // (`@@unique([tenantId, numberE164])`, plan §1), so a plain `upsert`
  // keyed on `numberE164` alone no longer identifies a unique row, and
  // `TenantClient` (src/lib/db-tenant.ts) deliberately does not expose the
  // raw tenantId this function would need to build the
  // `tenantId_numberE164` compound-key literal itself. findFirst (which the
  // extension tenant-filters automatically) + create/update instead —
  // same pattern as crm/activity.ts's recordActivity().
  const existingContact = await db.contact.findFirst({ where: { numberE164: event.fromE164 } });
  let contact = existingContact;
  if (!contact) {
    try {
      contact = await db.contact.create({
        // No `tenantId` — force-injected at runtime, see comment above.
        data: {
          numberE164: event.fromE164,
          displayName: event.contactName ?? undefined,
        } as unknown as Prisma.ContactUncheckedCreateInput,
      });
    } catch (err) {
      // Lost the create race against a concurrent inbound message for the
      // same number (findFirst -> create is no longer atomic now that the
      // upsert's compound key isn't buildable here — see comment above).
      // The other writer's row is what we want; re-fetch it.
      if (err instanceof Error && err.message.includes("Unique constraint")) {
        contact = await db.contact.findFirst({ where: { numberE164: event.fromE164 } });
      }
      if (!contact) throw err;
    }
  }
  // Adopt the provider's name only when we still have none (an outgoing
  // message's chatName is the account owner, so mapOpenWaMessage only sets
  // contactName for incoming — no extra guard needed here).
  if (event.contactName && !contact.displayName) {
    await db.contact
      .update({ where: { id: contact.id }, data: { displayName: event.contactName } })
      .catch(() => undefined);
  }

  const when = event.timestamp ?? new Date();
  const { conversation: found, created } = await findOrCreateConversation(db, contact.id, channel, waInstanceId, {
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

  // No `tenantId` — force-injected at runtime, see comment above.
  const message = await db.chatMessage.create({
    data: {
      conversationId: conversation.id,
      direction: outbound ? "OUTBOUND" : "INBOUND",
      body: event.mediaKind ? (event.body?.trim() || null) : event.body,
      mediaKind: event.mediaKind ?? null,
      mediaMimeType: event.mediaMimeType ?? null,
      mediaData: storedB64,
      mediaUrl: event.mediaKind ? `/api/messaging/media/PENDING` : null,
      providerMessageId: event.providerMessageId ?? null,
      waMessageId: event.waMessageId ?? null,
      deliveryStatus: event.deliveryStatus ?? (outbound ? "sent" : "delivered"),
      sensitive,
      createdAt: when,
    } as unknown as Prisma.ChatMessageUncheckedCreateInput,
  });

  // The proxy path needs the row id, known only after insert.
  if (event.mediaKind) {
    await db.chatMessage
      .update({ where: { id: message.id }, data: { mediaUrl: `/api/messaging/media/${message.id}` } })
      .catch(() => undefined);
  }

  await recordActivity(
    {
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
    },
    db,
  );

  if (opts.emit && !outbound) {
    void emitEvent(db, "message.received", {
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
  db: TenantClient,
  event: NormalizedInboundEvent,
  channel: Channel,
  waInstanceId: string | null
): Promise<void> {
  await persistNormalizedMessage(db, event, channel, waInstanceId, { bumpUnread: true, emit: true });
}
