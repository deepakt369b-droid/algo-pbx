// Workstream E — the provider-agnostic messaging contract.
//
// Every other part of the messaging feature (API routes, the agent chat UI,
// the admin SMS inbox) codes against `MessageProvider` and NEVER against
// OpenWA / Meta Cloud / Dinstar specifics. Which concrete adapter handles a
// given WaInstance is a *config value* (WaInstance.provider), resolved once
// in src/lib/messaging/registry.ts's getProvider() — there is deliberately
// no `if (provider === "OPENWA")` branch anywhere outside the adapters
// themselves.

/** Mirrors prisma's MessageProviderKind enum, restated as a plain string
 * union so pure-function unit tests can import this file without a
 * generated Prisma client being present. */
export type ProviderKind = "OPENWA" | "META_CLOUD" | "DINSTAR_SMS";

export type Channel = "WHATSAPP" | "SMS";

export interface SendTextInput {
  /** Provider-scoped instance/session identifier. For OpenWA this is the
   * OpenWA-assigned session id (WaInstance.openwaSessionId) — NOT
   * WaInstance.id; for Dinstar it is the SIM port number as a string; for
   * Meta Cloud it is ignored (the phone number id comes from
   * META_PHONE_NUMBER_ID). */
  instanceId: string;
  /** E.164 with leading '+', as stored on Contact.numberE164. Adapters that
   * need the bare-digits form (WhatsApp wa_id) strip it themselves. */
  toE164: string;
  text: string;
}

export interface SendMediaInput extends Omit<SendTextInput, "text"> {
  mediaUrl: string;
  mimeType?: string;
  caption?: string;
}

/** A pre-approved template message — required by Meta's WhatsApp Cloud
 * API for any message sent outside a 24h customer-service window,
 * including OTP delivery (which must use an "authentication" category
 * template). `params` fills the template's numbered placeholders in
 * order (e.g. `{{1}}` = params[0]). Only MetaCloudProvider implements
 * this — OpenWA has no equivalent concept (it can send free-form text at
 * any time since it isn't bound by Meta's business messaging policy),
 * and DinstarSmsProvider is SMS, not WhatsApp. */
export interface SendTemplateInput {
  instanceId: string;
  toE164: string;
  templateName: string;
  languageCode: string;
  params: string[];
}

export interface SendResult {
  /** Provider's own message id, when it returns one synchronously. Stored on
   * ChatMessage.providerMessageId for delivery-status correlation. */
  providerMessageId: string | null;
  status: "pending" | "sent" | "failed";
  error?: string;
}

export interface ProviderStatus {
  connected: boolean;
  /** Maps onto prisma's WaInstanceStatus. */
  status: "PAIRING" | "CONNECTED" | "DISCONNECTED" | "LOGGED_OUT";
  phoneE164?: string | null;
  /** A data: URL or raw string payload the admin UI can render as a QR
   * image while status === "PAIRING". Never shown to a non-admin. */
  qrCode?: string | null;
  /** Free-form provider response, surfaced to admins for debugging only. */
  raw?: unknown;
}

/** A single inbound message, already normalized away from provider wire
 * shape. `fromE164` is NOT yet run through normalizeToE164() — the ingest
 * layer (src/lib/messaging/ingest.ts) does that, so adapters stay pure
 * translation and the normalization rule lives in exactly one place. */
export interface NormalizedInboundEvent {
  channel: Channel;
  /** Best-effort E.164 (adapters prefix '+' onto a bare wa_id for us). */
  fromE164: string;
  body: string | null;
  mediaUrl?: string | null;
  mediaMimeType?: string | null;
  /** "voice" | "image" | "video" | "audio" | "document" | "sticker" when the
   * message carries media; ingest builds the mediaUrl proxy path from the
   * saved row id and this. */
  mediaKind?: string | null;
  /** Raw base64 of the media payload (OpenWA `metadata.media.data`), if the
   * sidecar included it. Ingest stashes it (size-capped) so the proxy can
   * serve received media the sidecar's own /media endpoint won't. */
  mediaBase64?: string | null;
  providerMessageId?: string | null;
  /** The provider's WhatsApp message id (OpenWA `waMessageId`), needed to
   * lazily pull the media bytes and to dedupe against history-sync. */
  waMessageId?: string | null;
  /** Contact's display name as the provider knows it (OpenWA `chatName`) —
   * ingest adopts it when we have no better name. */
  contactName?: string | null;
  /** "incoming" | "outgoing" — a full thread contains both; history-sync
   * ingests outgoing too. The webhook path only ever passes "incoming". */
  direction?: "incoming" | "outgoing" | null;
  deliveryStatus?: string | null;
  /** Provider-reported timestamp, if any. Ingest falls back to now(). */
  timestamp?: Date | null;
  /** Which paired identity received it — the adapter reports whatever the
   * provider gave it (session name / SIM port); ingest resolves it to a
   * WaInstance row. */
  instanceRef?: string | null;
}

export interface MessageProvider {
  readonly kind: ProviderKind;
  readonly channel: Channel;

  sendText(input: SendTextInput): Promise<SendResult>;
  sendMedia(input: SendMediaInput): Promise<SendResult>;
  getStatus(instanceId: string): Promise<ProviderStatus>;

  /** Send a pre-approved template message (Meta Cloud only — see
   * SendTemplateInput's comment). Used for OTP delivery, which must use
   * an authentication-category template outside the 24h session window.
   * Optional: providers with no template concept simply don't implement
   * it, same pattern as startPairing/logout below. */
  sendTemplate?(input: SendTemplateInput): Promise<SendResult>;

  /** Begin (or restart) pairing and return a QR / pairing payload. Optional:
   * Dinstar SMS has no pairing concept — the SIM is either in the slot or it
   * isn't. Admin-only call sites. */
  startPairing?(instanceId: string): Promise<ProviderStatus>;

  /** Terminate the provider-side session. ADMIN-ONLY — no agent-reachable
   * route may ever call this (hard product requirement). */
  logout?(instanceId: string): Promise<void>;

  /** Translate a raw webhook body (or poll response) into zero or more
   * normalized inbound events. Must never throw on malformed input —
   * return [] instead, so a garbage webhook can't 500 the route. */
  parseInbound(payload: unknown): NormalizedInboundEvent[];

  /** Providers with no push webhook (Dinstar) implement this instead; the
   * cron/poll route calls it. */
  pollInbound?(instanceId: string): Promise<NormalizedInboundEvent[]>;
}
