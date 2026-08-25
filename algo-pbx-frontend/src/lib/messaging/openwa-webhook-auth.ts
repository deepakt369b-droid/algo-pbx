import { createHmac, timingSafeEqual } from "node:crypto";

// Split out of the webhook route so it's unit-testable without spinning
// up a NextRequest. Verifies OpenWA's documented webhook signature scheme
// (docs/examples/webhook-signature-verification.md at the pinned commit):
// HMAC-SHA256 over the RAW request body, header value "sha256=<hex>".
export function verifyOpenWaSignature(rawBody: string, signatureHeader: string | null, secret: string): boolean {
  if (!signatureHeader || !secret) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(signatureHeader);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
