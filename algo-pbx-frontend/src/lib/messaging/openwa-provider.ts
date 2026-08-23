import { assertSafePathSegment, requestJson } from "./http";
import { e164ToWaId, waIdToE164 } from "./wa-id";
import { getSetting } from "@/lib/settings/service";
import type {
  MessageProvider,
  NormalizedInboundEvent,
  ProviderStatus,
  SendMediaInput,
  SendResult,
  SendTextInput,
} from "./types";

// ============================================================================
// UNVERIFIED API SURFACE — READ BEFORE TRUSTING
// ============================================================================
// OpenWA runs as a sidecar container (docker-compose.yml service `openwa`,
// reachable in-cluster at http://openwa:2785 via OPENWA_BASE_URL). Its REST
// surface has NOT been verified against a live instance from this codebase.
// The endpoints below are the plausible shape agreed in the brief:
//
//   POST {base}/api/instances/{instanceId}/messages/text   {to, content}
//   POST {base}/api/instances/{instanceId}/messages/media  {to, url, caption}
//   GET  {base}/api/instances/{instanceId}/status
//   POST {base}/api/instances/{instanceId}/start           -> begins pairing
//   GET  {base}/api/instances/{instanceId}/qrcode          -> {qr}
//   POST {base}/api/instances/{instanceId}/logout
//
// The real @open-wa/wa-automate EASY API exposes flat RPC-ish routes
// (e.g. POST /sendText with {args:{to, content}}) and scopes sessions with
// an `x-session-id`-style header rather than a path segment. If that turns
// out to be the deployed shape, ONLY this file changes — every call site
// codes against MessageProvider. That containment is the point.
//
// A HUMAN MUST VERIFY: endpoint paths, request/response body keys, the
// auth header name (assumed `api_key`, OpenWA's documented default), and
// the inbound webhook envelope parsed by parseInbound() below.
// ============================================================================

// Admin-configurable via /admin/settings, DB-first/env-fallback (see
// src/lib/settings/service.ts) — read fresh per call, no caching to
// invalidate here.
async function baseUrl(): Promise<string> {
  const url = (await getSetting("OPENWA_BASE_URL")) || "http://openwa:2785";
  return url.replace(/\/+$/, "");
}

async function authHeaders(): Promise<Record<string, string>> {
  const key = await getSetting("OPENWA_API_KEY");
  // OpenWA's documented header for its EASY API key.
  return key ? { api_key: key } : {};
}

/** instanceId is a WaInstance cuid, used as the OpenWA session name. It is
 * interpolated into a URL path, so it is validated, not escaped — see
 * http.ts's header on why. */
async function instanceUrl(instanceId: string, suffix: string): Promise<string> {
  return `${await baseUrl()}/api/instances/${assertSafePathSegment(instanceId, "instanceId")}${suffix}`;
}

interface OpenWaSendResponse {
  success?: boolean;
  response?: string | { id?: string };
  id?: string;
  error?: string;
}

function readMessageId(res: OpenWaSendResponse): string | null {
  if (typeof res.id === "string") return res.id;
  if (typeof res.response === "string") return res.response;
  if (res.response && typeof res.response === "object" && typeof res.response.id === "string") {
    return res.response.id;
  }
  return null;
}

export class OpenWaProvider implements MessageProvider {
  readonly kind = "OPENWA" as const;
  readonly channel = "WHATSAPP" as const;

  async sendText(input: SendTextInput): Promise<SendResult> {
    const waId = e164ToWaId(input.toE164);
    if (!waId) return { providerMessageId: null, status: "failed", error: "Destination is not E.164" };

    try {
      const [url, headers] = await Promise.all([instanceUrl(input.instanceId, "/messages/text"), authHeaders()]);
      const res = await requestJson<OpenWaSendResponse>(url, {
        method: "POST",
        headers,
        body: { to: `${waId}@c.us`, content: input.text },
      });
      return { providerMessageId: readMessageId(res), status: "sent" };
    } catch (err) {
      return { providerMessageId: null, status: "failed", error: (err as Error).message };
    }
  }

  async sendMedia(input: SendMediaInput): Promise<SendResult> {
    const waId = e164ToWaId(input.toE164);
    if (!waId) return { providerMessageId: null, status: "failed", error: "Destination is not E.164" };

    try {
      const [url, headers] = await Promise.all([instanceUrl(input.instanceId, "/messages/media"), authHeaders()]);
      const res = await requestJson<OpenWaSendResponse>(url, {
        method: "POST",
        headers,
        body: {
          to: `${waId}@c.us`,
          url: input.mediaUrl,
          caption: input.caption ?? "",
          mimetype: input.mimeType,
        },
      });
      return { providerMessageId: readMessageId(res), status: "sent" };
    } catch (err) {
      return { providerMessageId: null, status: "failed", error: (err as Error).message };
    }
  }

  async getStatus(instanceId: string): Promise<ProviderStatus> {
    try {
      const [url, headers] = await Promise.all([instanceUrl(instanceId, "/status"), authHeaders()]);
      const res = await requestJson<{
        state?: string;
        connected?: boolean;
        me?: { id?: string; user?: string };
        qr?: string;
      }>(url, { headers });

      const state = (res.state || "").toUpperCase();
      const connected = res.connected === true || state === "CONNECTED" || state === "MAIN";
      const status: ProviderStatus["status"] = connected
        ? "CONNECTED"
        : state.includes("QR") || state === "PAIRING" || state === "STARTING"
          ? "PAIRING"
          : state === "UNPAIRED" || state === "LOGGED_OUT" || state === "UNLAUNCHED"
            ? "LOGGED_OUT"
            : "DISCONNECTED";

      const rawId = res.me?.id ?? res.me?.user ?? null;
      return {
        connected,
        status,
        phoneE164: rawId ? waIdToE164(rawId) : null,
        qrCode: res.qr ?? null,
        raw: res,
      };
    } catch (err) {
      // A sidecar that can't be reached is DISCONNECTED, not an exception —
      // the admin page must still render, showing exactly that.
      return { connected: false, status: "DISCONNECTED", raw: { error: (err as Error).message } };
    }
  }

  async startPairing(instanceId: string): Promise<ProviderStatus> {
    // Two calls: kick the session, then fetch the QR it generated. OpenWA
    // generates the QR asynchronously, so a freshly-started session may
    // legitimately return no QR on the first poll — the admin UI polls.
    try {
      const [startUrl, headers] = await Promise.all([instanceUrl(instanceId, "/start"), authHeaders()]);
      await requestJson(startUrl, {
        method: "POST",
        headers,
        body: { sessionId: instanceId },
        timeoutMs: 30_000,
      });
    } catch {
      // Fall through: an already-running session may 4xx on /start. The
      // QR/status fetch below is the real answer either way.
    }

    try {
      const [qrUrl, headers] = await Promise.all([instanceUrl(instanceId, "/qrcode"), authHeaders()]);
      const qrRes = await requestJson<{ qr?: string; qrcode?: string; data?: string }>(qrUrl, { headers });
      const qr = qrRes.qr ?? qrRes.qrcode ?? qrRes.data ?? null;
      if (qr) return { connected: false, status: "PAIRING", qrCode: qr, raw: qrRes };
    } catch {
      // No QR yet (or endpoint shape differs) — report status instead.
    }

    const status = await this.getStatus(instanceId);
    return status.status === "DISCONNECTED" ? { ...status, status: "PAIRING" } : status;
  }

  async logout(instanceId: string): Promise<void> {
    // ADMIN-ONLY. The only caller is PATCH /api/admin/whatsapp/instances/[id],
    // which is requireAdminSession-gated. No agent-reachable route imports
    // this method — that is a hard product requirement, not a convention.
    const [url, headers] = await Promise.all([instanceUrl(instanceId, "/logout"), authHeaders()]);
    await requestJson(url, {
      method: "POST",
      headers,
      timeoutMs: 30_000,
    });
  }

  /**
   * Parse an OpenWA inbound webhook body. Assumed envelope (UNVERIFIED):
   *   { event: "onMessage", sessionId, data: { id, from, body, type,
   *     timestamp, mimetype?, deprecatedMms3Url? } }
   * Also tolerates a bare message object and an array of them.
   * Never throws — a malformed payload yields [].
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

        const mediaUrl =
          typeof m.deprecatedMms3Url === "string"
            ? m.deprecatedMms3Url
            : typeof m.mediaUrl === "string"
              ? m.mediaUrl
              : null;

        const ts = typeof m.timestamp === "number" ? new Date(m.timestamp * 1000) : null;

        events.push({
          channel: "WHATSAPP",
          fromE164,
          // A media message's `body` in OpenWA is the base64 payload, not
          // text — never store that as a chat bubble.
          body: mediaUrl ? (typeof m.caption === "string" ? m.caption : null) : body,
          mediaUrl,
          mediaMimeType: typeof m.mimetype === "string" ? m.mimetype : null,
          providerMessageId: typeof m.id === "string" ? m.id : null,
          timestamp: ts && !Number.isNaN(ts.getTime()) ? ts : null,
          instanceRef: sessionId ?? (typeof m.sessionId === "string" ? m.sessionId : null),
        });
      }
      return events;
    } catch {
      return [];
    }
  }
}
