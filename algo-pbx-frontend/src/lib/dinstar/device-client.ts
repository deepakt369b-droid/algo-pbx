// Low-level HTTP client for the Dinstar UC2000's WEB ADMIN UI
// (https://<ip>/enLogin.htm, https://<ip>/goform/*) — a cookie-session,
// form-post device, completely separate from src/lib/dinstar-discovery.ts's
// probeDinstarCredentials(), which talks to a DIFFERENT surface (the
// goip_get_status.html "GoIP-compatible" API, Basic/query auth, no
// cookies). Confirmed live 2026-08-29 by driving the real admin UI in a
// browser: this device wants a session cookie obtained by POSTing
// username/password as a form to /goform/IADIdentityAuth, then that
// cookie on every subsequent request. The cookie value itself was
// observed to equal the device's own serial number, not a per-login
// secret — consistent with sessions expiring quickly/being easy to
// invalidate, which prior sessions on this device already ran into
// repeatedly (see LLM.md/handoff.md's notes on the gateway UI's own
// session fragility).
//
// TLS: the admin UI is HTTPS-only with a self-signed certificate
// (confirmed live: plain HTTP 302-redirects to HTTPS). Using node:https
// directly with a dedicated Agent(rejectUnauthorized:false) — the same
// core-module approach src/lib/domain/cert-probe.ts already uses for a
// self-signed-cert case, rather than adding undici as a new direct
// dependency. This relaxation is scoped structurally: this module's own
// only purpose is talking to the one device at `host`, which every caller
// must have already passed through
// src/lib/dinstar-discovery.ts's assertProbeableHost() — never a
// general-purpose HTTPS client an unrelated caller could point anywhere.
//
// KNOWN LIMITATION, stated here so it cannot be missed: this client is
// WRITE-ONLY. The admin UI's Port Configuration page
// (https://<ip>/enPortList.htm) does not embed per-port values in its
// static HTML at all — confirmed live by fetching the raw page and
// inspecting its inline scripts: field names like "SipAcc0" are built by
// a client-side `for` loop, and the real values come from a mechanism
// this investigation could not identify without further invasive
// probing of the device (paused deliberately — see the session's own
// record of that decision). So there is no reliable way for this
// server-side client to READ current port config back, only to WRITE it.
// Every caller must treat a successful write as trusted from the
// device's own "Parameters OK" response text, not from a verified
// read-back — this is a real, accepted gap versus the original
// apply-and-verify design, not an oversight.

import https from "node:https";
import { randomBytes } from "node:crypto";

const REQUEST_TIMEOUT_MS = 10_000;

export interface DeviceLoginResult {
  ok: boolean;
  cookie?: string;
  error?: string;
}

export interface DeviceRequestResult {
  ok: boolean;
  status: number;
  body: string;
  /** The Location header on a redirect response, if any — this device
   * signals success/failure via WHICH page it redirects to
   * (/enSetOK.htm vs /enLogin.htm), confirmed live 2026-08-29, not via
   * response body content or a distinct status code. */
  location?: string;
  error?: string;
}

// One dedicated Agent, reused across requests to the SAME already-validated
// host for connection efficiency — never constructed with a caller-supplied
// host baked in, so it carries no risk of being pointed elsewhere.
const insecureAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });

function request(
  host: string,
  path: string,
  options: { method: "GET" | "POST"; body?: string; cookie?: string }
): Promise<DeviceRequestResult> {
  return new Promise((resolve) => {
    const headers: Record<string, string> = {};
    if (options.body) {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      headers["Content-Length"] = String(Buffer.byteLength(options.body));
    }
    if (options.cookie) headers["Cookie"] = options.cookie;

    const req = https.request(
      {
        host,
        port: 443,
        path,
        method: options.method,
        headers,
        agent: insecureAgent,
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            ok: (res.statusCode ?? 0) < 400,
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            location: res.headers.location,
          });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: 0, body: "", error: `Timed out after ${REQUEST_TIMEOUT_MS}ms.` });
    });
    req.on("error", (err) => {
      resolve({ ok: false, status: 0, body: "", error: err.message });
    });
    if (options.body) req.write(options.body);
    req.end();
  });
}

/** Extracts the raw Cookie header value from a response's Set-Cookie —
 * takes only the name=value pair, dropping Path/Expires/etc. attributes,
 * since that's all a subsequent Cookie request header needs. */
function extractCookie(setCookieHeader: string | undefined): string | undefined {
  if (!setCookieHeader) return undefined;
  return setCookieHeader.split(";")[0]?.trim() || undefined;
}

/** POST /goform/IADIdentityAuth with the admin UI's real login form field
 * names (username, password) confirmed live this session. A successful
 * login 302-redirects to enFrame.htm and sets the session cookie; this
 * function reads the Set-Cookie header directly rather than following the
 * redirect (node:https does not auto-follow, and there is nothing useful
 * on the redirect target itself). */
export function loginToDevice(host: string, username: string, password: string): Promise<DeviceLoginResult> {
  return new Promise((resolve) => {
    const body = new URLSearchParams({ username, password }).toString();
    const req = https.request(
      {
        host,
        port: 443,
        path: "/goform/IADIdentityAuth",
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": String(Buffer.byteLength(body)),
        },
        agent: insecureAgent,
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        // Drain the body regardless — an unconsumed response can leave the
        // socket in a state the keep-alive Agent can't safely reuse.
        res.on("data", () => undefined);
        res.on("end", () => {
          const cookie = extractCookie(res.headers["set-cookie"]?.[0]);
          const looksLikeSuccess = (res.statusCode ?? 0) < 400 && Boolean(cookie);
          resolve(
            looksLikeSuccess
              ? { ok: true, cookie }
              : { ok: false, error: `Login did not return a session cookie (status ${res.statusCode}). Check the username/password.` }
          );
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, error: `Timed out after ${REQUEST_TIMEOUT_MS}ms connecting to the gateway.` });
    });
    req.on("error", (err) => resolve({ ok: false, error: err.message }));
    req.write(body);
    req.end();
  });
}

/** POST a form body to an authenticated admin-UI endpoint (e.g.
 * /goform/PortCfg) using an already-obtained session cookie. */
export function postForm(host: string, cookie: string, path: string, formBody: string): Promise<DeviceRequestResult> {
  return request(host, path, { method: "POST", body: formBody, cookie });
}

/** GET a page from an authenticated admin-UI endpoint using an
 * already-obtained session cookie — added for vpn-push.ts's read-back
 * verification (re-fetching /enVPNCfg.htm to confirm OpenVPNEnable
 * actually rendered as checked, since unlike the SIM-port page this one is
 * static HTML with live values embedded and genuinely re-readable). Reuses
 * the same shared insecureAgent as every other request in this module —
 * no separate connection pool to the same host. */
export function getPage(host: string, cookie: string, path: string): Promise<DeviceRequestResult> {
  return request(host, path, { method: "GET", cookie });
}

export interface MultipartFile {
  /** The form field name the device expects the file under (e.g. "opvn"). */
  fieldName: string;
  filename: string;
  content: Buffer;
}

/** Builds a real RFC 2388 multipart/form-data body by hand — added for the
 * VPN Parameter form (POST /goform/VPNCfg, confirmed live to be
 * enctype="multipart/form-data" because it includes a file input), which
 * postForm()'s urlencoded-only body can't express. No new dependency:
 * Node's Buffer concatenation is entirely sufficient for a body this
 * simple (a handful of plain fields + one file part), matching this
 * module's existing zero-dependency style. */
export function buildMultipartBody(fields: Record<string, string>, file: MultipartFile, boundary: string): Buffer {
  const CRLF = "\r\n";
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}${CRLF}Content-Disposition: form-data; name="${name}"${CRLF}${CRLF}${value}${CRLF}`,
        "utf8"
      )
    );
  }

  parts.push(
    Buffer.from(
      `--${boundary}${CRLF}Content-Disposition: form-data; name="${file.fieldName}"; filename="${file.filename}"${CRLF}Content-Type: application/octet-stream${CRLF}${CRLF}`,
      "utf8"
    )
  );
  parts.push(file.content);
  parts.push(Buffer.from(CRLF, "utf8"));

  parts.push(Buffer.from(`--${boundary}--${CRLF}`, "utf8"));

  return Buffer.concat(parts);
}

/** POST a multipart/form-data body (plain fields + one file part) to an
 * authenticated admin-UI endpoint using an already-obtained session
 * cookie — the file-upload counterpart to postForm(). Field/filename
 * values are the operator's own settings/generated artifacts (DINSTAR_WEBUI_*,
 * a server-generated .ovpn filename), never raw end-user input, so no
 * additional escaping beyond the boundary/CRLF structure itself is
 * needed — the same trust boundary postForm()'s URLSearchParams-encoded
 * body already relies on. */
export function postMultipart(
  host: string,
  cookie: string,
  path: string,
  fields: Record<string, string>,
  file: MultipartFile
): Promise<DeviceRequestResult> {
  return new Promise((resolve) => {
    const boundary = `----AlgoPBX${randomBytes(16).toString("hex")}`;
    const body = buildMultipartBody(fields, file, boundary);

    const req = https.request(
      {
        host,
        port: 443,
        path,
        method: "POST",
        headers: {
          "Content-Type": `multipart/form-data; boundary=${boundary}`,
          "Content-Length": String(body.length),
          Cookie: cookie,
        },
        agent: insecureAgent,
        timeout: REQUEST_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            ok: (res.statusCode ?? 0) < 400,
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            location: res.headers.location,
          });
        });
      }
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, status: 0, body: "", error: `Timed out after ${REQUEST_TIMEOUT_MS}ms.` });
    });
    req.on("error", (err) => {
      resolve({ ok: false, status: 0, body: "", error: err.message });
    });
    req.write(body);
    req.end();
  });
}
