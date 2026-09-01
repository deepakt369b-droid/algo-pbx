import { db } from "@/lib/db";
import * as openwa from "./openwa-client";
import { mapOpenWaMessage } from "./openwa-provider";
import { persistNormalizedMessage } from "./ingest";
import { e164ToWaId } from "./wa-id";

// The OpenWA webhook only pushes NEW messages. Opening a thread triggers a
// rate-limited backlog pull so the agent sees the real history (and any
// media / own-side messages the webhook never delivered), matching WhatsApp
// Web's behaviour of showing the full conversation.
//
// BAN-RISK NOTE: this is a personal-use customer-service integration, NOT a
// marketing/bulk tool. Everything here is READ-side:
//  - message/history pulls read OpenWA's OWN local store, they do not query
//    WhatsApp per message (baileys can't — see engine-capability-matrix).
//  - `includeMedia` DOES make baileys download media blobs from WhatsApp's
//    CDN (normal client behaviour — your phone does the same), so the first
//    sync is deliberately capped small (FIRST_SYNC_MEDIA_LIMIT) and only
//    ever runs once per thread, paced by an agent opening one chat at a time.
//  - text-only history goes back further with no media downloads at all.
// No send-rate change, no unsolicited messages, no automation-at-scale.

const SYNC_COOLDOWN_MS = 45_000;
// Recent messages whose media we download on the one-time first sync. Small
// on purpose — keeps the CDN fetch burst modest. Older media still loads
// lazily via the /media proxy (sidecar fallback) when the agent scrolls to it.
const FIRST_SYNC_MEDIA_LIMIT = 80;
// Text-only backfill depth (no media downloads).
const FIRST_SYNC_TEXT_LIMIT = 400;

/**
 * Pull recent messages for one WhatsApp conversation from OpenWA and persist
 * any we don't already have. Best-effort and idempotent: never throws, dedupes
 * on waMessageId, and no-ops if it ran within the cooldown or the conversation
 * isn't a connected OpenWA thread.
 *
 * `force` skips the cooldown (used by the one-time admin backfill route).
 */
export async function syncConversationHistory(
  conversationId: string,
  opts: { limit?: number; deep?: boolean; force?: boolean } = {}
): Promise<{ synced: boolean; written: number; reason?: string }> {
  try {
    const conversation = await db.conversation.findUnique({
      where: { id: conversationId },
      include: { contact: true, waInstance: true },
    });
    if (!conversation) return { synced: false, written: 0, reason: "not found" };
    if (conversation.channel !== "WHATSAPP") return { synced: false, written: 0, reason: "not whatsapp" };

    if (
      !opts.force &&
      conversation.historySyncedAt &&
      Date.now() - conversation.historySyncedAt.getTime() < SYNC_COOLDOWN_MS
    ) {
      return { synced: false, written: 0, reason: "cooldown" };
    }

    const sessionId = conversation.waInstance?.openwaSessionId;
    const provider = conversation.waInstance?.provider;
    if (!sessionId || provider !== "OPENWA") {
      return { synced: false, written: 0, reason: "no openwa session" };
    }

    const waId = e164ToWaId(conversation.contact.numberE164);
    if (!waId) return { synced: false, written: 0, reason: "bad number" };
    const chatId = `${waId}@c.us`;

    const firstSync = !conversation.historySyncedAt;

    // Stamp first so concurrent polls (5s ChatThread interval) don't all fan
    // out to OpenWA at once.
    await db.conversation
      .update({ where: { id: conversationId }, data: { historySyncedAt: new Date() } })
      .catch(() => undefined);

    let rows;
    if (opts.deep) {
      rows = await openwa.getChatHistory(sessionId, chatId, { limit: opts.limit ?? 500, deep: true });
    } else if (firstSync || opts.force) {
      // Two passes: a small recent window WITH media, then a wider text-only
      // backfill (no CDN downloads). persistNormalizedMessage dedupes the
      // overlap and backfills mediaData onto any rows a prior text-only pass
      // created without it.
      const withMedia = await openwa.getChatMessages(sessionId, chatId, {
        limit: FIRST_SYNC_MEDIA_LIMIT,
        includeMedia: true,
      });
      const textOnly = await openwa.getChatMessages(sessionId, chatId, {
        limit: opts.limit ?? FIRST_SYNC_TEXT_LIMIT,
      });
      rows = [...textOnly, ...withMedia];
    } else {
      rows = await openwa.getChatMessages(sessionId, chatId, { limit: opts.limit ?? 60 });
    }

    let written = 0;
    for (const raw of rows) {
      const ev = mapOpenWaMessage(raw, sessionId);
      if (!ev) continue;
      const id = await persistNormalizedMessage(ev, "WHATSAPP", conversation.waInstanceId, {
        bumpUnread: false,
        emit: false,
      });
      if (id) written++;
    }

    return { synced: true, written };
  } catch (err) {
    // A failed first sync must not leave the thread permanently
    // half-populated behind the cooldown — clear the stamp so the next
    // poll retries.
    await db.conversation
      .update({ where: { id: conversationId }, data: { historySyncedAt: null } })
      .catch(() => undefined);
    return { synced: false, written: 0, reason: (err as Error).message };
  }
}

const AVATAR_TTL_MS = 6 * 60 * 60 * 1000; // re-check a contact's picture every 6h

/**
 * Resolve a contact's WhatsApp profile-picture URL, refreshing from OpenWA
 * when we have none or it's stale. Returns the raw pps.whatsapp.net URL (the
 * caller proxies it — that URL is cross-origin and expires) or null.
 */
export async function resolveContactAvatarUrl(contactId: string): Promise<string | null> {
  const contact = await db.contact.findUnique({
    where: { id: contactId },
    select: { id: true, numberE164: true, waAvatarUrl: true, waAvatarCheckedAt: true },
  });
  if (!contact) return null;

  const fresh =
    contact.waAvatarCheckedAt && Date.now() - contact.waAvatarCheckedAt.getTime() < AVATAR_TTL_MS;
  if (fresh) return contact.waAvatarUrl;

  // Find a connected OpenWA session that has talked to this contact.
  const conv = await db.conversation.findFirst({
    where: { contactId, channel: "WHATSAPP", waInstance: { provider: "OPENWA" } },
    include: { waInstance: true },
    orderBy: { lastMessageAt: "desc" },
  });
  const sessionId = conv?.waInstance?.openwaSessionId;
  const waId = e164ToWaId(contact.numberE164);
  if (!sessionId || !waId) {
    await db.contact
      .update({ where: { id: contactId }, data: { waAvatarCheckedAt: new Date() } })
      .catch(() => undefined);
    return contact.waAvatarUrl;
  }

  const url = await openwa.getContactProfilePicture(sessionId, `${waId}@c.us`).catch(() => null);
  await db.contact
    .update({
      where: { id: contactId },
      data: { waAvatarUrl: url ?? contact.waAvatarUrl, waAvatarCheckedAt: new Date() },
    })
    .catch(() => undefined);
  return url ?? contact.waAvatarUrl;
}
