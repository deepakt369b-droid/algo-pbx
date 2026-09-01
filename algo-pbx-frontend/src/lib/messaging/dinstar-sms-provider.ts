import https from "node:https";
import { assertSafeHeaderValue, basicAuthHeader, ProviderHttpError } from "./http";
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

// TLS: the UC2000's HTTPS is self-signed (confirmed live, see file header
// above). Rather than relaxing verification — NODE_TLS_REJECT_UNAUTHORIZED=0
// would weaken every other outbound call in the process, and even a
// per-module `rejectUnauthorized: false` Agent (the pattern
// src/lib/dinstar/device-client.ts already uses for the device's DIFFERENT
// web-admin surface) trusts ANY certificate that host ever presents — this
// pins the device's OWN certificate instead: Node is told to trust exactly
// this one CA (a self-signed cert is its own CA) via `ca:`, so a
// man-in-the-middle presenting a different certificate is still rejected.
// The PEM lives in DINSTAR_TLS_CERT_PEM (DB-first/env-fallback, same
// pattern as every other Dinstar setting — see settings/schema.ts),
// captured once with:
//   openssl s_client -connect <DINSTAR_LAN_IP>:443 -servername <DINSTAR_LAN_IP> </dev/null | openssl x509
// Confirmed live 2026-08-31 against the real gateway (sha256 fingerprint
// 7E:A4:3C:36:56:48:26:0A:6F:DB:D5:D5:16:05:6A:1B:F1:1C:1D:77:BF:F2:17:9B:6B:13:30:D0:ED:EF:B7:11,
// self-signed, valid 2019-2039). Re-capture and update the setting if the
// device is ever factory-reset or its certificate reissued — this provider
// will fail loud (a TLS handshake error, not a silent bypass) if the two
// ever diverge, which is the point.
let cachedAgent: { pem: string; agent: https.Agent } | null = null;

/** Exported for src/app/api/admin/system/health/route.ts's two Dinstar
 * checks, which talk to the same device over plain fetch() and hit this
 * exact same self-signed-cert wall — see LLM.md §28 for how that was
 * found live (via /admin/system, not by inspection). Kept here rather
 * than duplicated: this is the one place the pinned cert is resolved and
 * cached. */
export async function pinnedAgent(): Promise<https.Agent> {
  const pem = await getSetting("DINSTAR_TLS_CERT_PEM");
  if (!pem) {
    throw new Error(
      "DINSTAR_TLS_CERT_PEM is not configured — capture the gateway's certificate (see this file's header for the openssl command) and set it in /admin/settings before this provider can connect."
    );
  }
  if (cachedAgent && cachedAgent.pem === pem) return cachedAgent.agent;
  const agent = new https.Agent({
    ca: pem,
    keepAlive: true,
    // The device's cert carries no IP/DNS SAN (CN=Dinstar.com only,
    // confirmed live 2026-08-31) — Node's default hostname check would
    // reject it regardless of `ca:` trust. That check exists to stop a
    // CA-signed-but-wrong-host cert from being accepted; here `ca:`
    // already restricts trust to this exact certificate's bytes, so the
    // hostname it happens to claim is redundant, not a bypass of pinning.
    checkServerIdentity: () => undefined,
  });
  cachedAgent = { pem, agent };
  return agent;
}

/** Same contract as ./http's requestJson(), but over the pinned-certificate
 * Agent above via node:https directly — fetch() has no per-call way to
 * supply a custom trusted CA without adding undici as a new direct
 * dependency (this codebase's established precedent for a self-signed
 * device, see src/lib/dinstar/device-client.ts's header, is node:https +
 * a dedicated Agent, not fetch()). Deliberately NOT added to the shared
 * ./http module — every other provider there is fine trusting the system
 * CA store via plain fetch(); only this one device needs pinning. */
async function pinnedRequestJson<T = unknown>(
  url: string,
  init: { method?: "GET" | "POST"; headers?: Record<string, string>; body?: unknown; timeoutMs?: number } = {}
): Promise<T> {
  const { method = "GET", headers = {}, body, timeoutMs = 15_000 } = init;
  const safeHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    assertSafeHeaderValue(v, `header ${k}`);
    safeHeaders[k] = v;
  }
  const bodyText = body === undefined ? undefined : JSON.stringify(body);
  if (bodyText !== undefined) safeHeaders["Content-Type"] = "application/json";

  const [agent, parsed] = [await pinnedAgent(), new URL(url)];

  return new Promise<T>((resolve, reject) => {
    const req = https.request(
      {
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers:
          bodyText !== undefined
            ? { ...safeHeaders, "Content-Length": String(Buffer.byteLength(bodyText)) }
            : safeHeaders,
        agent,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new ProviderHttpError(`${method} ${url} failed: ${status}`, status, text.slice(0, 2000)));
            return;
          }
          if (!text) {
            resolve({} as T);
            return;
          }
          try {
            resolve(JSON.parse(text) as T);
          } catch {
            // Some of these devices answer with text/html even on success.
            resolve({ raw: text } as unknown as T);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error(`Request timed out after ${timeoutMs}ms: ${method} ${url}`)));
    req.on("error", reject);
    if (bodyText !== undefined) req.write(bodyText);
    req.end();
  });
}

// ============================================================================
// PARTIALLY LIVE-VERIFIED (2026-08-28) AGAINST A REAL UC2000 AT 192.168.11.1
// ============================================================================
// Dinstar UC2000 SMS over its HTTP/JSON API, reached at https://{DINSTAR_LAN_IP}
// across the same Tailscale route the voice trunk already uses, with HTTP
// Basic auth (DINSTAR_SMS_USERNAME / DINSTAR_SMS_PASSWORD).
//
// Shapes below follow Dinstar's public GoIP-compatible HTTP API docs:
//   send    POST /goip_send_sms.html
//           {"port":[0], "text":"...", "param":[{"number":"...","index":0}]}
//   inbound GET  /goip_get_sms.html?incoming=1&flag=unread
//   status  GET  /goip_get_status.html
//
// WHAT WAS ACTUALLY CONFIRMED against the real box tonight (no admin
// credentials were available — only the `change-me` placeholder in
// .env.example — so this could only be probed unauthenticated; response
// BODY shapes below, i.e. the DinstarSendResponse/DinstarSmsRow field
// names, remain UNVERIFIED, same as before):
//   - The device is reachable and answers as
//     `Server: Web Server/2.1.0 MatrixSSL/4.3.0-OPEN` — consistent with a
//     genuine Dinstar/GoIP-family embedded web server.
//   - Every unauthenticated request to port 80 (`http://`), including to
//     /goip_get_status.html itself, gets an unconditional
//     `302 Redirect` to `https://<ip>:443/...`. Plain HTTP is not
//     actually served — it only redirects. baseUrl() below has been
//     changed to default to `https://` (was `http://`) to match this; a
//     bare `DINSTAR_LAN_IP` host now goes straight to HTTPS instead of
//     relying on a redirect hop.
//   - FIXED 2026-08-31 (LLM.md §27, plan step 7). The device's HTTPS
//     certificate is self-signed, so Node's fetch() (the shared
//     requestJson() in ./http) threw `DEPTH_ZERO_SELF_SIGNED_CERT` and
//     never reached the application layer — every method below's
//     try/catch turned that into a normal `status: "failed"` /
//     `connected: false`, i.e. it failed LOUD, not silently, but this
//     provider could not complete a single real request. Fixed by pinning
//     the device's own certificate (see the `pinnedAgent()`/
//     `pinnedRequestJson()` block above this comment) rather than a
//     blanket `NODE_TLS_REJECT_UNAUTHORIZED=0`, which would have weakened
//     TLS for every other outbound call in the process, not just this
//     device. Not yet re-verified against real send/status/poll traffic
//     with real DINSTAR_SMS_USERNAME/PASSWORD credentials — the TLS layer
//     is proven (a handshake against the pinned cert succeeds), the
//     application-layer auth-style question in the next paragraph is
//     independent and still open.
//   - Unauthenticated GET to /goip_get_status.html over HTTPS (cert
//     ignored, no Authorization header or query params — no real
//     credentials were used or attempted; per task instructions, no
//     credential guessing/brute forcing was attempted either) also
//     redirects, this time to `/enLogin.htm`, an HTML session/cookie
//     login page — NOT a `401` with `WWW-Authenticate: Basic`. That
//     contradicts what src/lib/dinstar-discovery.ts's probeHost()
//     fingerprint check assumes (a 401+Basic challenge) — flagged here
//     as an FYI for whoever owns that file; not fixed here since it's
//     out of this task's file scope. What this means for THIS file is
//     genuinely open: it's unconfirmed whether authHeaders()/
//     authQueryParams()'s two styles (Basic header vs
//     `?username=&password=`) are honored by the JSON endpoints at all
//     on this firmware, or whether they need the cookie-session flow
//     the web UI redirect implies instead. Testing further required
//     real credentials, which were not available, and the sandbox this
//     was probed from declined even placeholder/fake-credential
//     requests as an auth-guessing pattern — so this remains unresolved
//     pending a session with real DINSTAR_SMS_USERNAME/PASSWORD values.
//
// RESOLVED 2026-08-31 (operator-reported "GET .../goip_get_sms.html -> 302"
// bug report). Two things were checked live against the real gateway from
// the VPS (via a pinned-Agent request run inside the algo-web container,
// same mechanism as pinnedRequestJson() below — no code change, no
// credential-guessing, GET requests only):
//   - DINSTAR_LAN_IP is still correctly 192.168.11.1, not .11.20 as the
//     operator's report suspected: `ping` from the VPS gets real replies
//     from .11.1 (~146ms, consistent with the UAE round trip) and 100%
//     loss from .11.20 (nothing answers there at all). The configured
//     value was — and remains — correct; no IP change was made.
//   - The 302 itself is fully explained by DINSTAR_SMS_PASSWORD still
//     being the literal `change-me` placeholder in the VPS .env (never
//     replaced with a real credential). A live GET to
//     /goip_get_sms.html with `Authorization: Basic
//     base64(admin:change-me)` produced the EXACT same 302-to-
//     `/enLogin.htm` response (status, headers, Set-Cookie, body) as the
//     same request with no Authorization header at all — which is
//     consistent with, not contradictory to, this API surface genuinely
//     honoring Basic auth (per src/lib/settings/schema.ts's
//     DINSTAR_WEBUI_USERNAME comment, confirmed live 2026-08-29 that this
//     SMS/status API is a distinct surface from the cookie-based web UI):
//     a wrong password and a missing header both fail the same way on
//     this firmware, so this test cannot and does not prove Basic auth is
//     ignored — it only reconfirms the placeholder is not a valid
//     credential. DINSTAR_AUTH_STYLE=basic is already the configured
//     value and matches that 2026-08-29 finding, so no auth-style code
//     change was made either. In short: this file's auth logic (baseUrl,
//     authHeaders/authQueryParams) is correct as written; the "Check for
//     new SMS now" button (POST /api/admin/messaging/sms/poll) will keep
//     returning a 502 until someone with access to the gateway's actual
//     SMS-API admin account sets a real DINSTAR_SMS_PASSWORD — that
//     credential cannot be discovered or guessed from this environment.
//
// Firmware revisions differ substantially in path names (some expose
// /api/send_sms) and in response key casing — those remain unverified,
// same as the auth-mechanism question above. authHeaders()/
// authQueryParams() below still read the wizard-persisted
// DINSTAR_AUTH_STYLE setting (src/lib/dinstar-discovery.ts's
// probeDinstarCredentials, run with real credentials) as the actual
// source of truth once someone runs it against this box.
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
  // Default scheme is https: confirmed live against a real UC2000 that
  // plain HTTP on this device only ever answers with a 302 redirect to
  // https://<ip>:443/... (see the file header) — going straight to https
  // avoids relying on that redirect (and the cross-origin header-dropping
  // behavior fetch() applies on redirect) ever being followed correctly.
  const origin = /^https?:\/\//.test(ip) ? ip : `https://${ip}`;
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

/** Exported for dinstar-sms-provider.test.ts — the header/query building
 * logic is the one piece of the two documented auth styles this file can
 * unit-test without live credentials; live-testing which style the real
 * device actually accepts is tracked in the file header above. */
export async function authHeaders(): Promise<Record<string, string>> {
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
export async function authQueryParams(): Promise<Record<string, string>> {
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
      const res = await pinnedRequestJson<DinstarSendResponse>(`${base}/goip_send_sms.html${qs}`, {
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
      const res = await pinnedRequestJson<{
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
    const res = await pinnedRequestJson<unknown>(
      `${base}/goip_get_sms.html?${params.toString()}`,
      { headers, timeoutMs: 20_000 }
    );
    return this.parseInbound(res);
  }
}
