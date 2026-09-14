// Shared fetch helper for provider adapters. Not part of the frozen
// contract — internal to src/lib/ai/providers/** only.
//
// Every adapter's listModels() must throw a clear, non-swallowed Error on
// network failure or a non-2xx response so the admin API route (which
// validates a freshly-entered API key by calling listModels()) can surface
// *why* validation failed instead of a generic 500.

// Strips the query string before a URL ever lands in a thrown Error.
// Post-verification finding (2026-09-14): gemini.ts puts the API key in the
// URL's `?key=` query param (that's Gemini's own auth scheme, not this
// file's choice) — an error message that echoed the full URL back would
// leak the plaintext key into the admin API's 422 response body. Every
// adapter's key belongs in a header EXCEPT Gemini's, so this sanitizes
// unconditionally rather than special-casing one provider.
function redactUrlForErrors(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return url.split("?")[0];
  }
}

export async function fetchJson(
  url: string,
  init: RequestInit,
  providerLabel: string
): Promise<unknown> {
  const safeUrl = redactUrlForErrors(url);
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${providerLabel}: network error calling ${safeUrl}: ${message}`);
  }
  if (!response.ok) {
    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch {
      // ignore — body isn't required for the error message to be useful
    }
    throw new Error(
      `${providerLabel}: request to ${safeUrl} failed with status ${response.status} ${response.statusText}${
        bodyText ? `: ${bodyText.slice(0, 500)}` : ""
      }`
    );
  }
  try {
    return await response.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${providerLabel}: failed to parse JSON response from ${safeUrl}: ${message}`);
  }
}

// SSRF guard for adapters that build a URL from an ADMIN-SUPPLIED value
// (today: only openai-compatible.ts's `baseUrl`, from
// AiProviderCredential.baseUrl). Post-verification finding (2026-09-14):
// without this, any tenant admin could point baseUrl at
// localhost/127.0.0.1/an RFC1918 address/a Docker service name/the cloud
// metadata address (169.254.169.254) and make THIS SERVER issue an
// authenticated fetch to it, with the (possibly truncated) response
// reflected back via fetchJson's error message — a classic SSRF pivot from
// a tenant-level account into the platform's internal network. Every other
// adapter in this directory uses a hardcoded vendor URL and does not need
// this check.
export function assertPublicHttpUrl(rawUrl: string, providerLabel: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`${providerLabel}: baseUrl is not a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${providerLabel}: baseUrl must be http(s)`);
  }
  const host = parsed.hostname.toLowerCase();
  const blocked =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "169.254.169.254" || // cloud metadata
    host === "metadata.google.internal" ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(host) ||
    /^169\.254\./.test(host) ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    !host.includes("."); // rejects bare hostnames like docker service names ("postgres", "web")
  if (blocked) {
    throw new Error(`${providerLabel}: baseUrl must be a public hostname, not an internal/private address`);
  }
}

export function requireApiKey(apiKey: string | null | undefined, providerLabel: string): string {
  if (!apiKey) {
    throw new Error(`${providerLabel}: apiKey is required`);
  }
  return apiKey;
}
