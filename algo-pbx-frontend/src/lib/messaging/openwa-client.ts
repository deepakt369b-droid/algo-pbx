// Thin typed client for OpenWA's real session-lifecycle REST API
// (/api/sessions/...), built on the same requestJson()/assertSafePathSegment()
// helpers every other provider adapter uses (see http.ts's header on why
// path segments and header values are validated, not escaped).
//
// This is deliberately NOT part of MessageProvider (types.ts) — pairing,
// session create/delete/start/stop, QR and pairing-code retrieval, and
// webhook registration are session-lifecycle concerns that the shared
// provider contract intentionally does not model (MessageProvider covers
// send/status/parseInbound across three very different backends). No new
// npm dependency is added for this either: the app builds with Next's
// `output: "standalone"`, and pinning the wire shape by hand in this one
// file — with the upstream commit recorded — is easier to audit than a
// second abstraction layer over an SDK whose version can drift from the
// server SHA independently.
//
// A HUMAN VERIFIED these paths against OpenWA's official SDK source at the
// pinned commit (99874630c9d386340d71f191b310c8bd8aa52ee3) — see
// openwa-types.ts's header. They are not guesses.

import { assertSafePathSegment, assertSafeWaChatId, requestBytes, requestJson } from "./http";
import { getSetting } from "@/lib/settings/service";
import {
  OPENWA_WEBHOOK_EVENTS,
  type OpenWaContactResponse,
  type OpenWaCreateSessionRequest,
  type OpenWaHistoryMessage,
  type OpenWaHistoryResponse,
  type OpenWaMessageResponse,
  type OpenWaPairingCodeResponse,
  type OpenWaProfilePictureResponse,
  type OpenWaQrCodeResponse,
  type OpenWaRegisterWebhookRequest,
  type OpenWaRequestPairingCodeRequest,
  type OpenWaSendAudioRequest,
  type OpenWaSendMediaRequest,
  type OpenWaSendTextRequest,
  type OpenWaSessionResponse,
  type OpenWaSessionStatsOverview,
  type OpenWaSuccessResult,
  type OpenWaWebhookResponse,
} from "./openwa-types";

async function baseUrl(): Promise<string> {
  const url = (await getSetting("OPENWA_BASE_URL")) || "http://openwa:2785";
  return url.replace(/\/+$/, "");
}

async function authHeaders(): Promise<Record<string, string>> {
  const key = await getSetting("OPENWA_API_KEY");
  return key ? { "X-API-Key": key } : {};
}

function sessionPath(sessionId: string, suffix = ""): string {
  return `/api/sessions/${assertSafePathSegment(sessionId, "openwaSessionId")}${suffix}`;
}

/** Derives an OpenWA session `name` (alphanumeric + hyphens, 3-50 chars)
 * from a WaInstance — used only at session-creation time; the session's
 * own `id` (persisted as WaInstance.openwaSessionId) is what every other
 * call uses afterward. */
export function sessionNameFor(instance: { simPort: number; id: string }): string {
  return `sim${instance.simPort}-${instance.id.slice(-8)}`;
}

export async function createSession(body: OpenWaCreateSessionRequest): Promise<OpenWaSessionResponse> {
  const [url, headers] = await Promise.all([baseUrl(), authHeaders()]);
  return requestJson<OpenWaSessionResponse>(`${url}/api/sessions`, { method: "POST", headers, body });
}

export async function listSessions(): Promise<OpenWaSessionResponse[]> {
  const [url, headers] = await Promise.all([baseUrl(), authHeaders()]);
  return requestJson<OpenWaSessionResponse[]>(`${url}/api/sessions`, { headers });
}

export async function getSession(sessionId: string): Promise<OpenWaSessionResponse> {
  const [url, headers] = await Promise.all([baseUrl(), authHeaders()]);
  return requestJson<OpenWaSessionResponse>(`${url}${sessionPath(sessionId)}`, { headers });
}

export async function deleteSession(sessionId: string): Promise<void> {
  const [url, headers] = await Promise.all([baseUrl(), authHeaders()]);
  await requestJson<void>(`${url}${sessionPath(sessionId)}`, { method: "DELETE", headers });
}

export async function startSession(sessionId: string): Promise<OpenWaSessionResponse> {
  const [url, headers] = await Promise.all([baseUrl(), authHeaders()]);
  return requestJson<OpenWaSessionResponse>(`${url}${sessionPath(sessionId, "/start")}`, {
    method: "POST",
    headers,
    timeoutMs: 30_000,
  });
}

export async function stopSession(sessionId: string): Promise<OpenWaSessionResponse> {
  const [url, headers] = await Promise.all([baseUrl(), authHeaders()]);
  return requestJson<OpenWaSessionResponse>(`${url}${sessionPath(sessionId, "/stop")}`, {
    method: "POST",
    headers,
    timeoutMs: 30_000,
  });
}

/** May reject with a ProviderHttpError carrying status 502 and body
 * `{code:"SESSION_LOGOUT_INCOMPLETE"}` per upstream's documented
 * incomplete-teardown case — callers decide whether to retry or force. */
export async function logoutSession(sessionId: string): Promise<OpenWaSessionResponse> {
  const [url, headers] = await Promise.all([baseUrl(), authHeaders()]);
  return requestJson<OpenWaSessionResponse>(`${url}${sessionPath(sessionId, "/logout")}`, {
    method: "POST",
    headers,
    timeoutMs: 30_000,
  });
}

export async function forceKillSession(sessionId: string): Promise<OpenWaSessionResponse> {
  const [url, headers] = await Promise.all([baseUrl(), authHeaders()]);
  return requestJson<OpenWaSessionResponse>(`${url}${sessionPath(sessionId, "/force-kill")}`, {
    method: "POST",
    headers,
    timeoutMs: 15_000,
  });
}

export async function getQr(sessionId: string): Promise<OpenWaQrCodeResponse> {
  const [url, headers] = await Promise.all([baseUrl(), authHeaders()]);
  return requestJson<OpenWaQrCodeResponse>(`${url}${sessionPath(sessionId, "/qr")}`, { headers });
}

export async function requestPairingCode(
  sessionId: string,
  body: OpenWaRequestPairingCodeRequest
): Promise<OpenWaPairingCodeResponse> {
  const [url, headers] = await Promise.all([baseUrl(), authHeaders()]);
  return requestJson<OpenWaPairingCodeResponse>(`${url}${sessionPath(sessionId, "/pairing-code")}`, {
    method: "POST",
    headers,
    body,
  });
}

export async function sendText(
  sessionId: string,
  body: OpenWaSendTextRequest
): Promise<OpenWaMessageResponse> {
  const [url, headers] = await Promise.all([baseUrl(), authHeaders()]);
  return requestJson<OpenWaMessageResponse>(`${url}${sessionPath(sessionId, "/messages/send-text")}`, {
    method: "POST",
    headers,
    body,
  });
}

export async function sendMedia(
  sessionId: string,
  body: OpenWaSendMediaRequest
): Promise<OpenWaMessageResponse> {
  const [baseUrlValue, headers] = await Promise.all([baseUrl(), authHeaders()]);
  return requestJson<OpenWaMessageResponse>(`${baseUrlValue}${sessionPath(sessionId, "/messages/send-media")}`, {
    method: "POST",
    headers,
    body,
  });
}

/** Registers OUR webhook + HMAC secret with this session — the
 * counterpart to the signature verification in
 * api/messaging/openwa-webhook/route.ts. Called once, right after
 * createSession(), from POST /api/admin/whatsapp/instances. */
export async function registerSessionWebhook(
  sessionId: string,
  body: OpenWaRegisterWebhookRequest
): Promise<OpenWaWebhookResponse> {
  const [url, headers] = await Promise.all([baseUrl(), authHeaders()]);
  return requestJson<OpenWaWebhookResponse>(`${url}${sessionPath(sessionId, "/webhooks")}`, {
    method: "POST",
    headers,
    body: { events: [...OPENWA_WEBHOOK_EVENTS], ...body },
  });
}

export async function sendAudio(
  sessionId: string,
  body: OpenWaSendAudioRequest
): Promise<OpenWaMessageResponse> {
  const [url, headers] = await Promise.all([baseUrl(), authHeaders()]);
  return requestJson<OpenWaMessageResponse>(`${url}${sessionPath(sessionId, "/messages/send-audio")}`, {
    method: "POST",
    headers,
    body,
    timeoutMs: 30_000,
  });
}

// ---------------------------------------------------------------------------
// History + media + contacts (2026-09-01). OpenWA's webhook only pushes NEW
// messages; these pull endpoints are what backfills a thread, fetches a
// received voice note's bytes, and resolves a profile picture.
// ---------------------------------------------------------------------------

/** Recent messages for one chat (most-recent first). `includeMedia` inlines
 * base64 for messages that have it — slower; leave off and pull bytes lazily
 * via getMessageMedia() for received media. */
export async function getChatMessages(
  sessionId: string,
  chatId: string,
  opts: { limit?: number; includeMedia?: boolean } = {}
): Promise<OpenWaHistoryMessage[]> {
  const [url, headers] = await Promise.all([baseUrl(), authHeaders()]);
  const q = new URLSearchParams({ chatId: assertSafeWaChatId(chatId), limit: String(opts.limit ?? 50) });
  if (opts.includeMedia) q.set("includeMedia", "true");
  const res = await requestJson<OpenWaHistoryResponse | OpenWaHistoryMessage[]>(
    `${url}${sessionPath(sessionId, "/messages")}?${q.toString()}`,
    // includeMedia downloads every attachment's bytes — allow much longer.
    { headers, timeoutMs: opts.includeMedia ? 90_000 : 25_000 }
  );
  return Array.isArray(res) ? res : (res.messages ?? []);
}

/** Deep chat history (up to ~2000 with `deep`, engine-dependent). Metadata
 * only. Used for the one-time fuller backfill of a thread. */
export async function getChatHistory(
  sessionId: string,
  chatId: string,
  opts: { limit?: number; deep?: boolean } = {}
): Promise<OpenWaHistoryMessage[]> {
  const [url, headers] = await Promise.all([baseUrl(), authHeaders()]);
  const q = new URLSearchParams({ limit: String(opts.limit ?? 100) });
  if (opts.deep) q.set("deep", "true");
  const path = sessionPath(sessionId, `/messages/${assertSafeWaChatId(chatId)}/history`);
  const res = await requestJson<OpenWaHistoryResponse | OpenWaHistoryMessage[]>(`${url}${path}?${q.toString()}`, {
    headers,
    timeoutMs: 40_000,
  });
  return Array.isArray(res) ? res : (res.messages ?? []);
}

/** The stored bytes for one message's media (archived file, or the inline
 * copy for media this account sent). 404 => no stored media. */
export async function getMessageMedia(
  sessionId: string,
  chatId: string,
  waMessageId: string
): Promise<{ bytes: Buffer; contentType: string | null }> {
  const [url, headers] = await Promise.all([baseUrl(), authHeaders()]);
  const path = sessionPath(
    sessionId,
    `/messages/${assertSafeWaChatId(chatId)}/${assertSafeWaChatId(waMessageId, "message id")}/media`
  );
  return requestBytes(`${url}${path}`, { headers, timeoutMs: 25_000 });
}

export async function getContact(sessionId: string, contactId: string): Promise<OpenWaContactResponse> {
  const [url, headers] = await Promise.all([baseUrl(), authHeaders()]);
  return requestJson<OpenWaContactResponse>(
    `${url}${sessionPath(sessionId, `/contacts/${assertSafeWaChatId(contactId)}`)}`,
    { headers }
  );
}

/** The pps.whatsapp.net URL for a contact's picture, or null. That URL
 * expires and is cross-origin — callers proxy it, never hand it to a browser. */
export async function getContactProfilePicture(
  sessionId: string,
  contactId: string
): Promise<string | null> {
  const [url, headers] = await Promise.all([baseUrl(), authHeaders()]);
  try {
    const res = await requestJson<OpenWaProfilePictureResponse>(
      `${url}${sessionPath(sessionId, `/contacts/${assertSafeWaChatId(contactId)}/profile-picture`)}`,
      { headers }
    );
    return typeof res.url === "string" && res.url ? res.url : null;
  } catch {
    return null;
  }
}

export async function statsOverview(): Promise<OpenWaSessionStatsOverview> {
  const [url, headers] = await Promise.all([baseUrl(), authHeaders()]);
  return requestJson<OpenWaSessionStatsOverview>(`${url}/api/sessions/stats/overview`, { headers });
}

export async function health(): Promise<OpenWaSuccessResult> {
  const url = await baseUrl();
  return requestJson<OpenWaSuccessResult>(`${url}/api/health/ready`);
}
