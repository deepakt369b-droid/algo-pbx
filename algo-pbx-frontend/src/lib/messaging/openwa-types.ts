// Wire types for OpenWA's real REST API, hand-transcribed from the
// official JS SDK at the exact commit this deployment is pinned to
// (vendor/openwa/prepare.sh: OPENWA_COMMIT = 99874630c9d386340d71f191b310c8bd8aa52ee3).
// Source files: sdk/javascript/src/types.ts, sdk/javascript/src/resources/sessions.ts.
//
// This supersedes the invented `/api/instances/{id}/...` surface that used
// to live in openwa-provider.ts — that shape never existed on any real
// OpenWA server. If OpenWA is ever re-pinned to a newer commit, diff this
// file against the SDK's types.ts for that commit before assuming it still
// matches.

/** Upstream's session lifecycle enum (types.ts). There is no upstream
 * status meaning "logged out by an admin" — that is WaInstanceStatus's
 * LOGGED_OUT, which we set ourselves; see toWaInstanceStatus() below. */
export type OpenWaSessionStatus =
  | "created"
  | "initializing"
  | "qr_ready"
  | "authenticating"
  | "ready"
  | "disconnected"
  | "action_required"
  | "failed";

export interface OpenWaAccountRestriction {
  [key: string]: unknown;
}

export interface OpenWaSessionResponse {
  id: string;
  name: string;
  status: OpenWaSessionStatus;
  phone?: string | null;
  pushName?: string | null;
  connectedAt?: string | null;
  lastActive?: string | null;
  createdAt: string;
  updatedAt: string;
  /** Only present when status is "failed" or "action_required". */
  lastError?: string | null;
  restriction?: OpenWaAccountRestriction | null;
}

export interface OpenWaCreateSessionRequest {
  /** Alphanumeric + hyphens, 3-50 chars. */
  name: string;
  config?: Record<string, unknown>;
  proxyUrl?: string;
  proxyType?: "http" | "https" | "socks4" | "socks5";
}

export interface OpenWaQrCodeResponse {
  /** data:image/png;base64,... */
  qrCode: string;
  status: OpenWaSessionStatus;
}

export interface OpenWaPairingCodeResponse {
  /** 8-character code, e.g. "ABCD1234". */
  pairingCode: string;
  status: string;
}

export interface OpenWaRequestPairingCodeRequest {
  /** Digits only, international format, no leading '+' (e.g. "971544887712"). */
  phoneNumber: string;
}

export interface OpenWaSessionStatsOverview {
  total: number;
  active: number;
  ready: number;
  disconnected: number;
  byStatus: Record<string, number>;
}

export interface OpenWaMessageResponse {
  messageId: string;
  [key: string]: unknown;
}

/** Body for POST /api/sessions/{id}/messages/send-text. The destination
 * field is `chatId` (a JID, e.g. "971501234567@c.us") — NOT `to`. This was
 * the exact shape of a real, reproduced 400 from a live send: the wire
 * body openwa-client.ts used to build had a `to` key that the real
 * send-text DTO does not recognize at all, so validation rejected the
 * request outright. Source: sdk/javascript/src/types.ts `SendTextRequest`
 * at the pinned commit (see this file's header). */
export interface OpenWaSendTextRequest {
  chatId: string;
  text: string;
}

/** Body for POST /api/sessions/{id}/messages/send-media (and the
 * send-image/send-video/send-document/send-sticker aliases the real
 * client resource picks by suffix). Same `chatId`-not-`to` correction as
 * OpenWaSendTextRequest — see its comment. Source: sdk/javascript/src/
 * types.ts `SendMediaRequest`. */
export interface OpenWaSendMediaRequest {
  chatId: string;
  url?: string;
  base64?: string;
  mimetype?: string;
  filename?: string;
  caption?: string;
}

export interface OpenWaSuccessResult {
  success: boolean;
  message?: string;
}

/** Body for POST /api/sessions/{id}/messages/send-audio. Extends send-media
 * with `ptt` — `ptt: true` produces a WhatsApp voice note (push-to-talk
 * bubble), `false`/absent a regular audio file. Source: message.controller.js
 * SendAudioMessageDto at this deployment's pinned OpenWA (v0.23.1). */
export interface OpenWaSendAudioRequest extends OpenWaSendMediaRequest {
  ptt?: boolean;
}

/** One row from GET /api/sessions/{id}/messages?chatId=... and the
 * /{chatId}/history endpoint. Hand-transcribed from a live v0.23.1 response
 * (see src/lib/messaging/openwa-provider.ts). Media for messages sent BY this
 * account arrives inline as base64 under metadata.media; for received media
 * the bytes are fetched separately via /{chatId}/{waMessageId}/media. */
export interface OpenWaHistoryMessage {
  id: string;
  waMessageId: string;
  chatId: string;
  chatName?: string | null;
  from?: string | null;
  to?: string | null;
  body?: string | null;
  /** "text" | "voice" | "audio" | "image" | "video" | "document" | "sticker" | ... */
  type?: string | null;
  direction?: "incoming" | "outgoing" | null;
  /** unix seconds */
  timestamp?: number | null;
  status?: string | null;
  metadata?: {
    media?: { mimetype?: string | null; data?: string | null } | null;
  } | null;
  mediaMimetype?: string | null;
}

export interface OpenWaHistoryResponse {
  messages: OpenWaHistoryMessage[];
}

export interface OpenWaContactResponse {
  id: string;
  name?: string | null;
  pushName?: string | null;
  number?: string | null;
  isMyContact?: boolean;
}

export interface OpenWaProfilePictureResponse {
  /** null / absent when the contact has no picture or it is private. */
  url?: string | null;
}

/** Per-session webhook registration (POST /api/sessions/{id}/webhooks) —
 * OpenWA has no global webhook config; every session's webhook is set up
 * individually, which is why session creation in openwa-client.ts always
 * follows create with a webhook registration call. */
export interface OpenWaRegisterWebhookRequest {
  url: string;
  secret?: string;
  events?: string[];
}

export interface OpenWaWebhookResponse {
  id: string;
  url: string;
  events: string[];
  createdAt: string;
}

/** The event names this deployment cares about — message delivery and
 * session lifecycle. OpenWA supports more; only subscribe to what
 * registerSessionWebhook() actually needs. */
export const OPENWA_WEBHOOK_EVENTS = ["message.received", "session.status"] as const;

/** Delivery headers documented at docs/examples/webhook-signature-verification.md —
 * verify X-OpenWA-Signature (HMAC-SHA256 of the RAW body) before trusting a
 * payload. See src/app/api/messaging/openwa-webhook/route.ts. */
export const OPENWA_SIGNATURE_HEADER = "x-openwa-signature";
export const OPENWA_EVENT_HEADER = "x-openwa-event";
export const OPENWA_IDEMPOTENCY_HEADER = "x-openwa-idempotency-key";
export const OPENWA_DELIVERY_ID_HEADER = "x-openwa-delivery-id";
export const OPENWA_RETRY_COUNT_HEADER = "x-openwa-retry-count";

/** Maps OpenWA's session status onto our coarser WaInstanceStatus enum.
 * qr_ready/created/initializing/authenticating are all still "in the
 * process of pairing" from the admin's point of view; disconnected and
 * failed both mean "not usable right now, needs attention" — the specific
 * upstream status and any lastError stay available via
 * WaInstance.providerStatusRaw / lastError for debugging. action_required
 * means WhatsApp itself flagged something (see restriction) — surfaced as
 * DISCONNECTED with lastError set by the caller, not silently dropped. */
export function toWaInstanceStatus(
  status: OpenWaSessionStatus
): "PAIRING" | "CONNECTED" | "DISCONNECTED" {
  switch (status) {
    case "created":
    case "initializing":
    case "qr_ready":
    case "authenticating":
      return "PAIRING";
    case "ready":
      return "CONNECTED";
    case "disconnected":
    case "failed":
    case "action_required":
      return "DISCONNECTED";
    default:
      return "DISCONNECTED";
  }
}
