import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getProvider } from "@/lib/messaging/registry";
import { ingestInboundEvent } from "@/lib/messaging/ingest";
import { getSetting } from "@/lib/settings/service";
import { verifyOpenWaSignature } from "@/lib/messaging/openwa-webhook-auth";
import {
  OPENWA_DELIVERY_ID_HEADER,
  OPENWA_EVENT_HEADER,
  OPENWA_IDEMPOTENCY_HEADER,
  OPENWA_SIGNATURE_HEADER,
} from "@/lib/messaging/openwa-types";

export const dynamic = "force-dynamic";

// POST /api/messaging/openwa-webhook — inbound WhatsApp events pushed by
// the OpenWA sidecar, to whichever URL we registered per-session at
// pairing time (src/lib/messaging/openwa-client.ts's
// registerSessionWebhook, OPENWA_WEBHOOK_URL setting).
//
// Verified against the raw request body with HMAC-SHA256, per OpenWA's
// documented webhook-signature-verification scheme (X-OpenWA-Signature:
// "sha256=<hex>", computed over the exact raw bytes — NOT the re-serialized
// JSON, which can differ in whitespace/key order — see
// openwa-webhook-auth.ts). This supersedes the previous `x-webhook-secret`
// header check, which compared against an invented header name that
// OpenWA never sends.
export async function POST(request: NextRequest) {
  // MUST read the raw body before any JSON parsing — the signature is
  // computed over the exact bytes OpenWA sent, and re-serializing first
  // (even losslessly) can produce a different byte sequence.
  const rawBody = await request.text();

  const secret = await getSetting("OPENWA_WEBHOOK_SECRET");
  if (!secret || !verifyOpenWaSignature(rawBody, request.headers.get(OPENWA_SIGNATURE_HEADER), secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = JSON.parse(rawBody || "null");
  if (!payload) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  // Dedupe on OpenWA's idempotency key — a delivery that doesn't get a 2xx
  // is retried (X-OpenWA-Retry-Count), and re-ingesting an already-seen
  // delivery would duplicate the ChatMessage row.
  const idempotencyKey = request.headers.get(OPENWA_IDEMPOTENCY_HEADER);
  const eventName = request.headers.get(OPENWA_EVENT_HEADER) ?? "unknown";
  if (idempotencyKey) {
    try {
      await db.inboundWebhookDelivery.create({
        data: {
          idempotencyKey,
          deliveryId: request.headers.get(OPENWA_DELIVERY_ID_HEADER),
          event: eventName,
        },
      });
    } catch {
      // Unique-constraint violation = already processed this delivery.
      return NextResponse.json({ ok: true, duplicate: true });
    }
  }

  // session.status carries live status without waiting for the admin
  // page's poll — update it directly rather than routing through
  // parseInbound(), which is scoped to message events.
  if (eventName === "session.status") {
    const sessionId = typeof (payload as Record<string, unknown>)?.sessionId === "string" ? (payload as Record<string, unknown>).sessionId as string : null;
    if (sessionId) {
      await db.waInstance
        .updateMany({ where: { openwaSessionId: sessionId }, data: { lastStatusAt: new Date() } })
        .catch(() => undefined);
    }
    return NextResponse.json({ ok: true });
  }

  const provider = getProvider("OPENWA");
  const events = provider.parseInbound(payload);

  for (const event of events) {
    // instanceRef is the OpenWA-assigned session id, not WaInstance.id —
    // resolve it to a WaInstance row via the persisted openwaSessionId.
    const waInstance = event.instanceRef
      ? await db.waInstance.findUnique({ where: { openwaSessionId: event.instanceRef } })
      : null;
    await ingestInboundEvent(event, "WHATSAPP", waInstance?.id ?? null);
  }

  return NextResponse.json({ ok: true, ingested: events.length });
}
