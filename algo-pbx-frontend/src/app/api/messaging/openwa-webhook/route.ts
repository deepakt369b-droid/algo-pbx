import { NextRequest, NextResponse } from "next/server";
import { unsafeGlobalDb } from "@/lib/db";
import { tenantDb } from "@/lib/db-tenant";
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
//
// Wave 2a/2c multi-tenant migration — tenant resolution design:
// This route has NO session and NO API key — its only caller identity is
// the HMAC signature above, and OpenWA's own payload carries no tenantId
// (it has never heard of tenants). The only thing in the payload that maps
// to a tenant is `instanceRef` — OpenWA's own session id — which resolves,
// via the persisted `WaInstance.openwaSessionId`, to the WaInstance row
// that row belongs to, and every WaInstance has a `tenantId`.
// So: FIRST look up the owning WaInstance with `unsafeGlobalDb` (there is
// no tenant to scope by yet — this is the one deliberately-unscoped read,
// same shape as `api-key-auth.ts`'s own key lookup), THEN build a
// `tenantDb(waInstance.tenantId)` from that row's tenant and use it for
// every write downstream (`ingestInboundEvent`, the session.status update).
// An event whose `instanceRef` doesn't match any known WaInstance cannot be
// attributed to a tenant at all and is skipped rather than guessed at.
// `InboundWebhookDelivery` (the idempotency-dedupe table below) stays on
// `unsafeGlobalDb` throughout — it's platform-global by design
// (`src/lib/tenancy/scope-rules.ts`'s `PLATFORM_GLOBAL_MODELS`), since a
// single OpenWA delivery id must dedupe across the whole platform, not
// per-tenant.
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
      await unsafeGlobalDb.inboundWebhookDelivery.create({
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
      // Unscoped lookup deliberately: no tenant is known until this row
      // tells us one (see file header). Once resolved, the actual update
      // runs through that tenant's own scoped client.
      const instance = await unsafeGlobalDb.waInstance.findUnique({ where: { openwaSessionId: sessionId } });
      if (instance) {
        await tenantDb(instance.tenantId)
          .waInstance.update({ where: { id: instance.id }, data: { lastStatusAt: new Date() } })
          .catch(() => undefined);
      }
    }
    return NextResponse.json({ ok: true });
  }

  const provider = getProvider("OPENWA");
  const events = provider.parseInbound(payload);

  let ingested = 0;
  for (const event of events) {
    // instanceRef is the OpenWA-assigned session id, not WaInstance.id —
    // resolve it to a WaInstance row via the persisted openwaSessionId.
    // Unscoped by necessity (see file header) — this is the ONLY place the
    // event's owning tenant can be determined.
    const waInstance = event.instanceRef
      ? await unsafeGlobalDb.waInstance.findUnique({ where: { openwaSessionId: event.instanceRef } })
      : null;
    if (!waInstance) {
      // No known WaInstance for this session id — cannot attribute a
      // tenant, so this event is dropped rather than guessed at.
      continue;
    }
    await ingestInboundEvent(tenantDb(waInstance.tenantId), event, "WHATSAPP", waInstance.id);
    ingested += 1;
  }

  return NextResponse.json({ ok: true, ingested });
}
