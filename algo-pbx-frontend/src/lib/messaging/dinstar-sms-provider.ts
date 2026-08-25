import { basicAuthHeader, requestJson } from "./http";
import { normalizeToE164 } from "../phone-normalize";
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
// UNVERIFIED AGAINST A LIVE UC2000 — NEEDS LIVE TESTING
// ============================================================================
// Dinstar UC2000 SMS over its HTTP/JSON API, reached at http://{DINSTAR_LAN_IP}
// across the same Tailscale route the voice trunk already uses, with HTTP
// Basic auth (DINSTAR_SMS_USERNAME / DINSTAR_SMS_PASSWORD).
//
// Shapes below follow Dinstar's public GoIP-compatible HTTP API docs:
//   send    POST /goip_send_sms.html
//           {"port":[0], "text":"...", "param":[{"number":"...","index":0}]}
//   inbound GET  /goip_get_sms.html?incoming=1&flag=unread
//   status  GET  /goip_get_status.html
//
// Firmware revisions differ substantially in path names (some expose
// /api/send_sms) and in response key casing — those remain unverified.
// The auth-mechanism half of this caveat is resolved: the /admin/dinstar
// setup wizard's probe step (src/lib/dinstar-discovery.ts) tries both
// Basic auth and the `?username=&password=` query-string style against
// the real device and persists which one worked as the DINSTAR_AUTH_STYLE
// setting — authHeaders()/authQueryParams() below read it. Everything
// else in this file must still be checked against the actual unit before
// being trusted in production.
//
// PORT NUMBERING: the UC2000 HTTP API is 0-indexed (port 0..3) while
// WaInstance.simPort in prisma/schema.prisma is 1-indexed (1..4) because
// that is how the ports are labelled on the hardware. simPortToApiPort()
// below is the single place that conversion happens — do not open-code it.
//
// INBOUND IS POLLED, NOT PUSHED. The UC2000 has no documented outbound
// webhook, so there is no /api/messaging/dinstar-webhook route. Inbound SMS
// arrives via pollInbound(), driven by
// POST /api/admin/messaging/sms/poll (admin-triggered, and intended to be
// hit by a cron — see that route's header for the crontab line). If a given
// firmware DOES support an SMS-forward-to-URL setting, that push can be
// wired to the same ingest layer later without touching this adapter.
// ============================================================================

// Admin-configurable via /admin/settings, DB-first/env-fallback (see
// src/lib/settings/service.ts) — read fresh per call, no caching to
// invalidate here.
async function baseUrl(): Promise<string> {
  const ip = (await getSetting("DINSTAR_LAN_IP")) || "";
  if (!ip) throw new Error("DINSTAR_LAN_IP is not configured");
  // Accept a bare IP or a full origin; reject anything with a path/query so
  // we can't be pointed at an arbitrary URL by a bad configured value.
  const origin = /^https?:\/\//.test(ip) ? ip : `http://${ip}`;
  const url = new URL(origin);
  if (url.pathname !== "/" || url.search) {
    throw new Error("DINSTAR_LAN_IP must be a host or origin, not a URL with a path");
  }
  return url.origin;
}

/** One of the two UNVERIFIED-no-longer auth styles Dinstar firmware
 * variants use, discovered once by the /admin/dinstar wizard's probe step
 * (src/lib/dinstar-discovery.ts's probeDinstarCredentials) and persisted
 * as the DINSTAR_AUTH_STYLE setting — permanently resolving what used to
 * be one of this file's two UNVERIFIED caveats. Falls back to "basic"
 * (the more common style) if the wizard has never been run. */
async function authStyle(): Promise<"basic" | "query"> {
  const style = await getSetting("DINSTAR_AUTH_STYLE");
  return style === "query" ? "query" : "basic";
}

async function authHeaders(): Promise<Record<string, string>> {
  if ((await authStyle()) === "query") return {};
  const [username, password] = await Promise.all([
    getSetting("DINSTAR_SMS_USERNAME"),
    getSetting("DINSTAR_SMS_PASSWORD"),
  ]);
  return { Authorization: basicAuthHeader(username || "", password || "") };
}

/** Query-string auth params to append when DINSTAR_AUTH_STYLE is "query"
 * — empty otherwise, so callers can unconditionally spread this into
 * their URLSearchParams. */
async function authQueryParams(): Promise<Record<string, string>> {
  if ((await authStyle()) !== "query") return {};
  const [username, password] = await Promise.all([
    getSetting("DINSTAR_SMS_USERNAME"),
    getSetting("DINSTAR_SMS_PASSWORD"),
  ]);
  return { username: username || "", password: password || "" };
}

/** WaInstance.simPort (1-4, as labelled on the hardware) -> UC2000 HTTP API
 * port index (0-3). The ONLY place this off-by-one lives. */
export function simPortToApiPort(simPort: number): number {
  if (!Number.isInteger(simPort) || simPort < 1 || simPort > 4) {
    throw new Error(`simPort must be an integer 1-4, got ${simPort}`);
  }
  return simPort - 1;
}

/** instanceId for this provider is the SIM port as a string ("1".."4"). */
function apiPortFromInstanceId(instanceId: string): number {
  const n = Number(instanceId);
  return simPortToApiPort(n);
}

interface DinstarSendResponse {
  error_code?: number;
  sn?: string;
  result?: Array<{ port?: number; user_id?: number; number?: string; status?: string }>;
}

interface DinstarSmsRow {
  incoming_sms_id?: number;
  port?: number;
  number?: string;
  smsc?: string;
  timestamp?: string;
  text?: string;
  // Some firmwares use these key names instead:
  sender?: string;
  content?: string;
  time?: string;
}

export class DinstarSmsProvider implements MessageProvider {
  readonly kind = "DINSTAR_SMS" as const;
  readonly channel = "SMS" as const;

  async sendText(input: SendTextInput): Promise<SendResult> {
    let apiPort: number;
    try {
      apiPort = apiPortFromInstanceId(input.instanceId);
    } catch (err) {
      return { providerMessageId: null, status: "failed", error: (err as Error).message };
    }

    // The destination is untrusted (agent-typed). It goes into a JSON body,
    // not a header or a CRLF-framed protocol, but it is still normalized to
    // E.164 first so a crafted value can't reach the device verbatim.
    const to = normalizeToE164(input.toE164);
    if (!to) return { providerMessageId: null, status: "failed", error: "Destination is not a valid number" };

    try {
      const [base, headers, query] = await Promise.all([baseUrl(), authHeaders(), authQueryParams()]);
      const qs = Object.keys(query).length ? `?${new URLSearchParams(query)}` : "";
      const res = await requestJson<DinstarSendResponse>(`${base}/goip_send_sms.html${qs}`, {
        method: "POST",
        headers,
        body: {
          port: [apiPort],
          text: input.text,
          param: [{ number: to, index: 0 }],
        },
        timeoutMs: 20_000,
      });

      // Dinstar convention: error_code 200 (or absent) == accepted.
      const ok = res.error_code === undefined || res.error_code === 200;
      return {
        // `sn` is the device's own send serial number — the closest thing
        // to a provider message id the UC2000 offers.
        providerMessageId: res.sn ?? null,
        status: ok ? "sent" : "failed",
        error: ok ? undefined : `Dinstar error_code ${res.error_code}`,
      };
    } catch (err) {
      return { providerMessageId: null, status: "failed", error: (err as Error).message };
    }
  }

  async sendMedia(_input: SendMediaInput): Promise<SendResult> {
    // The UC2000 is an SMS gateway. MMS is not supported; failing loudly is
    // correct here rather than silently dropping an attachment.
    return {
      providerMessageId: null,
      status: "failed",
      error: "The Dinstar SMS gateway cannot send media (SMS only).",
    };
  }

  async getStatus(instanceId: string): Promise<ProviderStatus> {
    try {
      const apiPort = apiPortFromInstanceId(instanceId);
      const [base, headers, query] = await Promise.all([baseUrl(), authHeaders(), authQueryParams()]);
      const qs = Object.keys(query).length ? `?${new URLSearchParams(query)}` : "";
      const res = await requestJson<{
        error_code?: number;
        status?: Array<{ port?: number; type?: string; gsm_remain_credit?: string; sim?: string }>;
      }>(`${base}/goip_get_status.html${qs}`, { headers, timeoutMs: 10_000 });

      const port = res.status?.find((s) => s.port === apiPort);
      // "Registered" / "OK" vary by firmware — treat any non-empty,
      // non-"unregistered" state as up.
      const state = (port?.type || "").toLowerCase();
      const connected = Boolean(port) && state !== "" && !state.includes("unregist") && state !== "no sim";

      return {
        connected,
        status: connected ? "CONNECTED" : "DISCONNECTED",
        phoneE164: null, // the UC2000 does not reliably report the SIM's MSISDN
        raw: port ?? res,
      };
    } catch (err) {
      return { connected: false, status: "DISCONNECTED", raw: { error: (err as Error).message } };
    }
  }

  // No pairing, no logout — a SIM is either in the slot or it isn't.

  /** Also usable if a firmware turns out to push SMS to a URL: the same
   * row shape is parsed either way. */
  parseInbound(payload: unknown): NormalizedInboundEvent[] {
    try {
      const root = payload as { sms?: unknown; result?: unknown } | null;
      if (!root || typeof root !== "object") return [];
      const rows = Array.isArray(root.sms)
        ? root.sms
        : Array.isArray(root.result)
          ? root.result
          : Array.isArray(payload)
            ? (payload as unknown[])
            : [];

      const events: NormalizedInboundEvent[] = [];
      for (const raw of rows) {
        const r = raw as DinstarSmsRow;
        const from = r.number ?? r.sender ?? "";
        const fromE164 = normalizeToE164(from);
        if (!fromE164) continue;

        const body = r.text ?? r.content ?? null;
        const tsRaw = r.timestamp ?? r.time ?? null;
        const ts = tsRaw ? new Date(tsRaw.replace(" ", "T")) : null;

        events.push({
          channel: "SMS",
          fromE164,
          body,
          mediaUrl: null,
          mediaMimeType: null,
          providerMessageId: r.incoming_sms_id !== undefined ? String(r.incoming_sms_id) : null,
          timestamp: ts && !Number.isNaN(ts.getTime()) ? ts : null,
          // Report back in the 1-indexed hardware numbering the rest of the
          // app uses, so ingest can match WaInstance.simPort directly.
          instanceRef: typeof r.port === "number" ? String(r.port + 1) : null,
        });
      }
      return events;
    } catch {
      return [];
    }
  }

  /** Poll the device for unread inbound SMS. `instanceId` may be a SIM port
   * ("1".."4") to scope the poll to one port, or "" / "all" for every port. */
  async pollInbound(instanceId: string): Promise<NormalizedInboundEvent[]> {
    const params = new URLSearchParams({ incoming: "1", flag: "unread" });
    if (instanceId && instanceId !== "all") {
      params.set("port", String(apiPortFromInstanceId(instanceId)));
    }
    const [base, headers, query] = await Promise.all([baseUrl(), authHeaders(), authQueryParams()]);
    for (const [k, v] of Object.entries(query)) params.set(k, v);
    const res = await requestJson<unknown>(
      `${base}/goip_get_sms.html?${params.toString()}`,
      { headers, timeoutMs: 20_000 }
    );
    return this.parseInbound(res);
  }
}
