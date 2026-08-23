import { assertSafeHeaderValue, assertSafePathSegment, requestJson } from "./http";
import { e164ToWaId, waIdToE164 } from "./wa-id";
import { requireSetting } from "@/lib/settings/service";
import type {
  MessageProvider,
  NormalizedInboundEvent,
  ProviderStatus,
  SendMediaInput,
  SendResult,
  SendTemplateInput,
  SendTextInput,
} from "./types";

// Meta WhatsApp Cloud API adapter — the FALLBACK provider (OpenWA is
// primary). Unlike OpenWA this API surface IS publicly documented and
// stable, so the shapes here are far more trustworthy:
//
//   POST https://graph.facebook.com/v20.0/{PHONE_NUMBER_ID}/messages
//        Authorization: Bearer {META_WABA_TOKEN}
//        {messaging_product:"whatsapp", to, type:"text", text:{body}}
//
// Two structural differences from OpenWA that the interface papers over:
//  1. There is no per-instance session — one WABA phone number id
//     (META_PHONE_NUMBER_ID) serves everything, so `instanceId` is accepted
//     and ignored by send/status.
//  2. There is no pairing and no logout. `startPairing`/`logout` are
//     therefore NOT implemented (the interface marks them optional); the
//     admin route reports "not supported by this provider" rather than
//     pretending to succeed.
//
// A HUMAN MUST VERIFY: that the WABA number is registered and the token is
// a long-lived system-user token, and that the webhook subscription is
// pointed at /api/messaging/meta-webhook.

const GRAPH_VERSION = "v20.0";

// Both settings resolve DB-first, env-fallback (src/lib/settings/service.ts)
// — admin-configurable from /admin/settings, no client caching to
// invalidate here since these are read fresh on every call already.
async function phoneNumberId(): Promise<string> {
  const id = await requireSetting("META_PHONE_NUMBER_ID");
  return assertSafePathSegment(id, "META_PHONE_NUMBER_ID");
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await requireSetting("META_WABA_TOKEN");
  assertSafeHeaderValue(token, "META_WABA_TOKEN");
  return { Authorization: `Bearer ${token}` };
}

interface MetaSendResponse {
  messages?: Array<{ id?: string }>;
  error?: { message?: string };
}

export class MetaCloudProvider implements MessageProvider {
  readonly kind = "META_CLOUD" as const;
  readonly channel = "WHATSAPP" as const;

  private async post(body: unknown): Promise<SendResult> {
    try {
      const [id, headers] = await Promise.all([phoneNumberId(), authHeaders()]);
      const res = await requestJson<MetaSendResponse>(
        `https://graph.facebook.com/${GRAPH_VERSION}/${id}/messages`,
        { method: "POST", headers, body }
      );
      return { providerMessageId: res.messages?.[0]?.id ?? null, status: "sent" };
    } catch (err) {
      return { providerMessageId: null, status: "failed", error: (err as Error).message };
    }
  }

  async sendText(input: SendTextInput): Promise<SendResult> {
    const waId = e164ToWaId(input.toE164);
    if (!waId) return { providerMessageId: null, status: "failed", error: "Destination is not E.164" };
    return this.post({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: waId,
      type: "text",
      // preview_url false: an agent pasting a link shouldn't trigger Meta
      // fetching arbitrary URLs on our behalf.
      text: { preview_url: false, body: input.text },
    });
  }

  async sendMedia(input: SendMediaInput): Promise<SendResult> {
    const waId = e164ToWaId(input.toE164);
    if (!waId) return { providerMessageId: null, status: "failed", error: "Destination is not E.164" };
    const kind = (input.mimeType || "").startsWith("image/")
      ? "image"
      : (input.mimeType || "").startsWith("video/")
        ? "video"
        : (input.mimeType || "").startsWith("audio/")
          ? "audio"
          : "document";
    return this.post({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: waId,
      type: kind,
      [kind]: { link: input.mediaUrl, ...(kind === "audio" ? {} : { caption: input.caption ?? "" }) },
    });
  }

  /**
   * OTP delivery for the registration/2FA fallback path (Workstream 2 of
   * the agent-registration plan) — only triggered when Firebase Phone
   * Auth has already failed. `templateName` must be an
   * authentication-category template pre-approved in the Meta Business
   * Manager (Meta will reject an unapproved name at send time, not at
   * build time — this is unverified against a live WABA and needs the
   * template actually approved before trusting it). Authentication
   * templates conventionally take exactly one param (the code) with a
   * `{{1}}` body placeholder and a "Copy code" quick-reply button Meta
   * generates automatically from the template config, not from this call.
   */
  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    const waId = e164ToWaId(input.toE164);
    if (!waId) return { providerMessageId: null, status: "failed", error: "Destination is not E.164" };
    return this.post({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: waId,
      type: "template",
      template: {
        name: input.templateName,
        language: { code: input.languageCode },
        components: [
          {
            type: "body",
            parameters: input.params.map((text) => ({ type: "text", text })),
          },
        ],
      },
    });
  }

  async getStatus(_instanceId: string): Promise<ProviderStatus> {
    // No session to inspect — the closest equivalent is asking Graph whether
    // the phone number id resolves and reporting its verified name.
    try {
      const [id, headers] = await Promise.all([phoneNumberId(), authHeaders()]);
      const res = await requestJson<{ id?: string; display_phone_number?: string; error?: unknown }>(
        `https://graph.facebook.com/${GRAPH_VERSION}/${id}?fields=display_phone_number,verified_name`,
        { headers }
      );
      return {
        connected: Boolean(res.id),
        status: res.id ? "CONNECTED" : "DISCONNECTED",
        phoneE164: res.display_phone_number
          ? waIdToE164(res.display_phone_number.replace(/[^\d]/g, ""))
          : null,
        raw: res,
      };
    } catch (err) {
      return { connected: false, status: "DISCONNECTED", raw: { error: (err as Error).message } };
    }
  }

  // Deliberately no startPairing / logout — see the file header. The admin
  // route checks for their presence and returns a clear 400 rather than a
  // silent no-op.

  /**
   * Parse a Meta Cloud webhook body. Documented envelope:
   *   { object:"whatsapp_business_account",
   *     entry:[{ id, changes:[{ value:{ messaging_product, metadata,
   *              contacts:[{wa_id}], messages:[{from,id,timestamp,type,
   *              text:{body}, image:{...}}] } }] }] }
   * Status-only callbacks (value.statuses) carry no messages and yield [].
   */
  parseInbound(payload: unknown): NormalizedInboundEvent[] {
    try {
      const root = payload as { entry?: unknown[] } | null;
      if (!root || !Array.isArray(root.entry)) return [];

      const events: NormalizedInboundEvent[] = [];
      for (const entry of root.entry) {
        const changes = (entry as { changes?: unknown[] })?.changes;
        if (!Array.isArray(changes)) continue;

        for (const change of changes) {
          const value = (change as { value?: Record<string, unknown> })?.value;
          const messages = value?.messages;
          if (!Array.isArray(messages)) continue;

          const metadata = value?.metadata as { phone_number_id?: string } | undefined;

          for (const raw of messages) {
            const m = raw as Record<string, unknown>;
            const fromE164 = waIdToE164(typeof m.from === "string" ? m.from : "");
            if (!fromE164) continue;

            const type = typeof m.type === "string" ? m.type : "text";
            const text = (m.text as { body?: string } | undefined)?.body ?? null;
            const media = m[type] as { link?: string; mime_type?: string; caption?: string } | undefined;
            const isMedia = ["image", "video", "audio", "document", "sticker"].includes(type);

            const tsSec = Number(m.timestamp);
            const ts = Number.isFinite(tsSec) ? new Date(tsSec * 1000) : null;

            events.push({
              channel: "WHATSAPP",
              fromE164,
              body: isMedia ? (media?.caption ?? null) : text,
              // Cloud API media is fetched by id via a second Graph call,
              // not a direct link — we record the id so a later fetch/
              // download job can resolve it. NOT a browser-loadable URL.
              mediaUrl: isMedia ? (media?.link ?? (m[type] as { id?: string })?.id ?? null) : null,
              mediaMimeType: isMedia ? (media?.mime_type ?? null) : null,
              providerMessageId: typeof m.id === "string" ? m.id : null,
              timestamp: ts && !Number.isNaN(ts.getTime()) ? ts : null,
              instanceRef: metadata?.phone_number_id ?? null,
            });
          }
        }
      }
      return events;
    } catch {
      return [];
    }
  }
}
