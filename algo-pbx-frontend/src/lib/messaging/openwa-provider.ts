import * as openwa from "./openwa-client";
import { e164ToWaId, waIdToE164 } from "./wa-id";
import {
  toWaInstanceStatus,
  type OpenWaHistoryMessage,
  type OpenWaSessionStatus,
} from "./openwa-types";
import type {
  MessageProvider,
  NormalizedInboundEvent,
  ProviderStatus,
  SendMediaInput,
  SendResult,
  SendTextInput,
} from "./types";

/** Map an OpenWA message `type` onto our coarse mediaKind, or null for a
 * plain text message. */
function mediaKindFor(type: string | null | undefined): string | null {
  switch ((type ?? "").toLowerCase()) {
    case "voice":
    case "ptt":
      return "voice";
    case "audio":
      return "audio";
    case "image":
      return "image";
    case "video":
      return "video";
    case "document":
    case "file":
      return "document";
    case "sticker":
      return "sticker";
    default:
      return null;
  }
}

/** Normalize one OpenWA message row (from the webhook `data` OR a
 * history/messages pull — same shape). `mediaUrl` is left null here; the
 * ingest layer builds the `/api/messaging/media/<rowId>` proxy path once the
 * row exists. Returns null for anything not attributable to an individual
 * contact (groups, broadcasts, unparseable). */
export function mapOpenWaMessage(
  raw: unknown,
  sessionId: string | null
): NormalizedInboundEvent | null {
  const m = raw as (OpenWaHistoryMessage & Record<string, unknown>) | null;
  if (!m || typeof m !== "object") return null;

  // direction: OpenWA uses "incoming"/"outgoing" (NOT a `fromMe` boolean —
  // that field simply doesn't exist and the old code's `m.fromMe === true`
  // check silently ingested our own outbound messages as inbound).
  const dir =
    m.direction === "outgoing" || m.direction === "incoming"
      ? m.direction
      : typeof (m as Record<string, unknown>).fromMe === "boolean"
        ? ((m as Record<string, unknown>).fromMe ? "outgoing" : "incoming")
        : "incoming";

  // The individual party on the far end: for incoming it's `from`, for
  // outgoing it's `to`. `chatId` is the same thing for a 1:1 chat.
  const party =
    (dir === "outgoing" ? m.to : m.from) ??
    m.chatId ??
    (typeof (m as Record<string, unknown>).author === "string"
      ? ((m as Record<string, unknown>).author as string)
      : "");
  const fromE164 = waIdToE164(String(party ?? ""));
  if (!fromE164) return null;

  const kind = mediaKindFor(m.type);
  const bodyText =
    typeof m.body === "string" && m.body.trim()
      ? m.body
      : typeof (m as Record<string, unknown>).caption === "string"
        ? ((m as Record<string, unknown>).caption as string)
        : null;

  const ts =
    typeof m.timestamp === "number"
      ? new Date(m.timestamp * 1000)
      : typeof m.timestamp === "string"
        ? new Date(m.timestamp)
        : null;

  const mime =
    m.metadata?.media?.mimetype ??
    m.mediaMimetype ??
    (typeof (m as Record<string, unknown>).mimetype === "string"
      ? ((m as Record<string, unknown>).mimetype as string)
      : null);

  // OpenWA inlines the media bytes here for both received and account-sent
  // messages; its dedicated /media endpoint only serves archived files, so
  // this is the reliable source.
  const mediaBase64 =
    typeof m.metadata?.media?.data === "string" && !/^https?:\/\//i.test(m.metadata.media.data)
      ? m.metadata.media.data
      : null;

  return {
    channel: "WHATSAPP",
    fromE164,
    // A media message's `body` is a caption at most — never the base64 blob
    // (which some engines drop into `body`); mapper already ignored that.
    body: bodyText,
    mediaUrl: null,
    mediaMimeType: mime ?? null,
    mediaKind: kind,
    mediaBase64,
    providerMessageId: typeof m.id === "string" ? m.id : null,
    waMessageId:
      typeof m.waMessageId === "string"
        ? m.waMessageId
        : typeof m.id === "string"
          ? m.id
          : null,
    // chatName on an outgoing row is the account owner, not the contact.
    contactName:
      dir === "incoming" && typeof m.chatName === "string" && m.chatName.trim() ? m.chatName : null,
    direction: dir,
    deliveryStatus: typeof m.status === "string" ? m.status.toLowerCase() : null,
    timestamp: ts && !Number.isNaN(ts.getTime()) ? ts : null,
    instanceRef:
      sessionId ??
      (typeof (m as Record<string, unknown>).sessionId === "string"
        ? ((m as Record<string, unknown>).sessionId as string)
        : null),
  };
}

// MessageProvider implementation for OpenWA, delegating all wire-format
// concerns to openwa-client.ts / openwa-types.ts (session lifecycle) —
// this file only translates between MessageProvider's generic shapes and
// the real OpenWA session API.
//
// IMPORTANT: `instanceId` everywhere below is the OpenWA-assigned SESSION
// id (persisted as WaInstance.openwaSessionId), NOT WaInstance.id. Every
// caller of getProvider("OPENWA").sendText/sendMedia/getStatus/etc. must
// resolve and pass openwaSessionId — see otp/service.ts's
// resolveOpenWaSessionId() and the conversations/[id]/messages route for
// the two real call sites.
//
// This supersedes a previous version of this file whose entire REST
// surface (`/api/instances/{id}/start|/qrcode|/status|/logout`) was
// invented and never matched any real OpenWA server — see
// openwa-types.ts's header for how the real shape was verified.

function readMessageId(res: { messageId?: string }): string | null {
  return typeof res.messageId === "string" ? res.messageId : null;
}

export class OpenWaProvider implements MessageProvider {
  readonly kind = "OPENWA" as const;
  readonly channel = "WHATSAPP" as const;

  async sendText(input: SendTextInput): Promise<SendResult> {
    const waId = e164ToWaId(input.toE164);
    if (!waId) return { providerMessageId: null, status: "failed", error: "Destination is not E.164" };

    try {
      const res = await openwa.sendText(input.instanceId, { chatId: `${waId}@c.us`, text: input.text });
      return { providerMessageId: readMessageId(res), status: "sent" };
    } catch (err) {
      return { providerMessageId: null, status: "failed", error: (err as Error).message };
    }
  }

  async sendMedia(input: SendMediaInput): Promise<SendResult> {
    const waId = e164ToWaId(input.toE164);
    if (!waId) return { providerMessageId: null, status: "failed", error: "Destination is not E.164" };

    try {
      const res = await openwa.sendMedia(input.instanceId, {
        chatId: `${waId}@c.us`,
        url: input.mediaUrl,
        caption: input.caption ?? "",
        mimetype: input.mimeType,
      });
      return { providerMessageId: readMessageId(res), status: "sent" };
    } catch (err) {
      return { providerMessageId: null, status: "failed", error: (err as Error).message };
    }
  }

  /** Send a WhatsApp voice note (ptt bubble). `base64` is the raw audio
   * payload; OpenWA transcodes to opus/ogg as WhatsApp requires. */
  async sendVoice(input: {
    instanceId: string;
    toE164: string;
    base64: string;
    mimeType: string;
  }): Promise<SendResult> {
    const waId = e164ToWaId(input.toE164);
    if (!waId) return { providerMessageId: null, status: "failed", error: "Destination is not E.164" };
    try {
      const res = await openwa.sendAudio(input.instanceId, {
        chatId: `${waId}@c.us`,
        base64: input.base64,
        mimetype: input.mimeType,
        ptt: true,
      });
      return { providerMessageId: readMessageId(res), status: "sent" };
    } catch (err) {
      return { providerMessageId: null, status: "failed", error: (err as Error).message };
    }
  }

  /** A sidecar that can't be reached is DISCONNECTED, not an exception —
   * the admin page must still render, showing exactly that. */
  async getStatus(instanceId: string): Promise<ProviderStatus> {
    try {
      const session = await openwa.getSession(instanceId);
      const status = toWaInstanceStatus(session.status);
      return {
        connected: status === "CONNECTED",
        status,
        phoneE164: session.phone ? waIdToE164(session.phone) : null,
        raw: session,
      };
    } catch (err) {
      return { connected: false, status: "DISCONNECTED", raw: { error: (err as Error).message } };
    }
  }

  /** Starts (or restarts) the session, then fetches its QR if one is
   * ready. OpenWA transitions through created -> initializing -> qr_ready
   * asynchronously, so a freshly-started session may legitimately have no
   * QR yet on this first call — the pairing GET route
   * (api/admin/whatsapp/instances/[id]/pairing) is what the admin UI
   * actually polls; this method is used by the create-instance route and
   * by "repair". */
  async startPairing(instanceId: string): Promise<ProviderStatus> {
    let session;
    try {
      session = await openwa.startSession(instanceId);
    } catch {
      // An already-running session may 4xx on /start — the status/QR
      // fetch below is the real answer either way.
      session = null;
    }

    const rawStatus: OpenWaSessionStatus = session?.status ?? "initializing";
    if (rawStatus === "qr_ready") {
      try {
        const qr = await openwa.getQr(instanceId);
        return { connected: false, status: "PAIRING", qrCode: qr.qrCode, raw: qr };
      } catch {
        // Fall through — status below still reports PAIRING.
      }
    }

    return this.getStatus(instanceId).then((status) =>
      status.status === "DISCONNECTED" && rawStatus !== "failed" && rawStatus !== "disconnected"
        ? { ...status, status: "PAIRING" as const }
        : status
    );
  }

  /** ADMIN-ONLY. The only caller is PATCH /api/admin/whatsapp/instances/[id],
   * which is requireAdminSession-gated. No agent-reachable route imports
   * this method — that is a hard product requirement, not a convention. */
  async logout(instanceId: string): Promise<void> {
    await openwa.logoutSession(instanceId);
  }

  /**
   * Parse an OpenWA `message.received` webhook body. Envelope (verified
   * against the pinned SDK's documented shape — see
   * docs/examples/webhook-signature-verification.md and
   * openwa-types.ts's header): the OUTER body carries `event`/`sessionId`
   * at the top level (also duplicated in the X-OpenWA-Event /
   * X-OpenWA-Delivery-Id headers, which the webhook route reads directly),
   * with the message itself under `data`. Tolerates a bare message object
   * and an array of them for resilience. Never throws — a malformed
   * payload yields [].
   */
  parseInbound(payload: unknown): NormalizedInboundEvent[] {
    try {
      const root = payload as Record<string, unknown> | null;
      if (!root || typeof root !== "object") return [];

      const sessionId = typeof root.sessionId === "string" ? root.sessionId : null;
      const data = "data" in root ? root.data : root;
      const items = Array.isArray(data) ? data : [data];

      const events: NormalizedInboundEvent[] = [];
      for (const item of items) {
        const ev = mapOpenWaMessage(item, sessionId);
        // The webhook is `message.received` — only ingest genuinely inbound
        // messages here. A full thread's outgoing side is backfilled by
        // history-sync.ts, which calls mapOpenWaMessage directly.
        if (ev && ev.direction !== "outgoing") events.push(ev);
      }
      return events;
    } catch {
      return [];
    }
  }
}
