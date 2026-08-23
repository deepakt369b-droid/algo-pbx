import { createHmac } from "node:crypto";

// Outbound webhook signing + delivery for CRM connectivity (Workstream G).
// SSRF guard: reject private/reserved hosts and non-http(s) schemes. This is
// a synchronous URL-level check; it does not resolve hostnames, so DNS-based
// rebinding could still bypass it. If that threat model matters, add async
// resolution + IP checking before fetch.

function isPrivateOrReservedHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".local")) return true;

  // IPv4 private/reserved ranges
  const ipv4 = lower;
  if (
    ipv4 === "0.0.0.0" ||
    ipv4.startsWith("127.") ||
    ipv4.startsWith("10.") ||
    ipv4.startsWith("192.168.") ||
    ipv4.startsWith("169.254.") ||
    /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ipv4) ||
    /^(22[4-9]|23[0-9])\./.test(ipv4) ||
    /^(24[0-9]|25[0-5])\./.test(ipv4)
  ) {
    return true;
  }

  // IPv6 loopback / link-local
  if (lower === "::1" || lower.startsWith("fe80:") || lower.startsWith("fc") || lower.startsWith("fd")) {
    return true;
  }

  return false;
}

function assertWebhookUrlSafe(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Invalid webhook URL");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Webhook URL must use http or https");
  }

  const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
  const allowedPorts = ["80", "443", "8080", "8443"];
  if (!allowedPorts.includes(port)) {
    throw new Error("Webhook URL port not allowed");
  }

  if (isPrivateOrReservedHost(parsed.hostname)) {
    throw new Error("Webhook URL points to a private or reserved host");
  }
}

// Outbound webhook signing + delivery for CRM connectivity (Workstream G).
// A recipient verifies X-AlgoPBX-Signature (HMAC-SHA256 hex of the raw
// request body) against a shared secret before trusting a payload —
// standard webhook-signing practice, same idea as Stripe/GitHub webhooks.

export function signWebhookPayload(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

const RETRY_DELAYS_MS = [1000, 4000, 16000];

export interface SendWebhookResult {
  ok: boolean;
  attempts: number;
  lastStatus?: number;
  lastError?: string;
}

/** POSTs one webhook with signing headers, retrying on non-2xx or network
 * error. This is fire-and-forget-with-retries, not a durable queue — a
 * recipient down for longer than the retry window loses that event. Good
 * enough for the trial; a real queue (or at-least-once redelivery worker)
 * is the natural next step if delivery guarantees become a hard
 * requirement. */
export async function sendWebhook(url: string, event: string, payload: object, secret: string): Promise<SendWebhookResult> {
  assertWebhookUrlSafe(url);

  const body = JSON.stringify(payload);
  const signature = signWebhookPayload(body, secret);
  const timestamp = new Date().toISOString();

  let lastStatus: number | undefined;
  let lastError: string | undefined;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AlgoPBX-Event": event,
          "X-AlgoPBX-Signature": signature,
          "X-AlgoPBX-Timestamp": timestamp,
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      lastStatus = res.status;
      if (res.ok) return { ok: true, attempts: attempt + 1, lastStatus };
    } catch (err) {
      lastError = err instanceof Error ? err.message : "unknown error";
    }

    if (attempt < RETRY_DELAYS_MS.length) {
      await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
    }
  }

  console.error(`Webhook delivery failed after retries: ${url} (event=${event}, lastStatus=${lastStatus}, lastError=${lastError})`);
  return { ok: false, attempts: RETRY_DELAYS_MS.length + 1, lastStatus, lastError };
}
