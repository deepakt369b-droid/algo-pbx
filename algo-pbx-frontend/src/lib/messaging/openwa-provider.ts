import * as openwa from "./openwa-client";
import { e164ToWaId, waIdToE164 } from "./wa-id";
import { toWaInstanceStatus, type OpenWaSessionStatus } from "./openwa-types";
import type {
  MessageProvider,
  NormalizedInboundEvent,
  ProviderStatus,
  SendMediaInput,
  SendResult,
  SendTextInput,
} from "./types";

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
      const res = await openwa.sendText(input.instanceId, { to: `${waId}@c.us`, text: input.text });
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
        to: `${waId}@c.us`,
        url: input.mediaUrl,
        caption: input.caption ?? "",
        mimetype: input.mimeType,
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
        const m = item as Record<string, unknown> | null;
        if (!m || typeof m !== "object") continue;

        // Ignore our own echoed outbound messages.
        if (m.fromMe === true) continue;

        const from = typeof m.from === "string" ? m.from : typeof m.author === "string" ? m.author : "";
        const fromE164 = waIdToE164(from);
        if (!fromE164) continue; // group / broadcast / unparseable

        const body =
          typeof m.body === "string"
            ? m.body
            : typeof m.text === "string"
              ? m.text
              : typeof m.caption === "string"
                ? m.caption
                : null;

        const mediaUrl = typeof m.mediaUrl === "string" ? m.mediaUrl : null;

        const ts =
          typeof m.timestamp === "number"
            ? new Date(m.timestamp * 1000)
            : typeof m.timestamp === "string"
              ? new Date(m.timestamp)
              : null;

        events.push({
          channel: "WHATSAPP",
          // A media message's `body` may be a base64 payload rather than
          // text depending on engine — never store that as a chat bubble.
          body: mediaUrl ? (typeof m.caption === "string" ? m.caption : null) : body,
          mediaUrl,
          mediaMimeType: typeof m.mimetype === "string" ? m.mimetype : null,
          providerMessageId: typeof m.id === "string" ? m.id : null,
          timestamp: ts && !Number.isNaN(ts.getTime()) ? ts : null,
          fromE164,
          instanceRef: sessionId ?? (typeof m.sessionId === "string" ? m.sessionId : null),
        });
      }
      return events;
    } catch {
      return [];
    }
  }
}
