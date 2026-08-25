// Small shared HTTP helpers for the provider adapters.
//
// Note on input safety: src/lib/ami-client.ts historically interpolated
// untrusted values straight into a CRLF-framed wire protocol (fixed
// elsewhere). The same class of bug applies here — an instance id or phone
// number interpolated into a URL path, or a value put into an HTTP header,
// is untrusted input reaching a wire protocol. Everything that leaves this
// module through a path segment or a header goes through the validators
// below first; there is no "it's probably fine" path.

/** Path segments we build URLs from must be plain identifier-ish tokens.
 * cuid()s, numeric SIM ports and OpenWA session names all satisfy this;
 * anything containing '/', '?', '#', '..', whitespace or a control char
 * does not and is rejected outright rather than escaped. */
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9_-]{1,128}$/;

export function assertSafePathSegment(value: string, label = "path segment"): string {
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new Error(`Unsafe ${label}: ${JSON.stringify(value)}`);
  }
  return value;
}

/** HTTP header values may not contain CR, LF or NUL (RFC 9110 §5.5). A
 * secret pulled from env should never contain them, but a misconfigured
 * .env with a trailing newline is exactly how header injection gets in. */
export function assertSafeHeaderValue(value: string, label = "header value"): string {
  if (/[\r\n\0]/.test(value)) {
    throw new Error(`Unsafe ${label}: contains CR/LF/NUL`);
  }
  return value;
}

export class ProviderHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string
  ) {
    super(message);
    this.name = "ProviderHttpError";
  }
}

export interface JsonRequestInit {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

/** fetch() + JSON + a hard timeout. A hung sidecar must not hang a Next.js
 * request handler indefinitely. */
export async function requestJson<T = unknown>(url: string, init: JsonRequestInit = {}): Promise<T> {
  const { method = "GET", headers = {}, body, timeoutMs = 15_000 } = init;

  const safeHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    assertSafeHeaderValue(v, `header ${k}`);
    safeHeaders[k] = v;
  }
  if (body !== undefined) safeHeaders["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: safeHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
      cache: "no-store",
    });
    const text = await res.text();
    if (!res.ok) {
      throw new ProviderHttpError(`${method} ${url} failed: ${res.status}`, res.status, text.slice(0, 2000));
    }
    if (!text) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // Some of these devices answer with text/html even on success.
      return { raw: text } as unknown as T;
    }
  } finally {
    clearTimeout(timer);
  }
}

/** HTTP Basic credential, header-injection-checked. */
export function basicAuthHeader(username: string, password: string): string {
  assertSafeHeaderValue(username, "basic auth username");
  assertSafeHeaderValue(password, "basic auth password");
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}
