import type { TenantClient } from "@/lib/db-tenant";
import { sendWebhook } from "@/lib/webhooks";

// emitEvent("call.ended", {...}) — looks up every active WebhookSubscription
// whose `events` array contains this event name and delivers to each. Fire-
// and-forget from the caller's perspective (not awaited by request handlers
// that call this — see api/cdr/route.ts's call site) so a slow or down CRM
// endpoint never adds latency to the request that triggered the event.
//
// Event names used so far: "call.ended" (api/cdr/route.ts, on CDR ingest).
// src/app/api/messaging/** (owned by a different workstream) is expected to
// call this for "message.received"/"message.sent" — this export is the
// clean, reusable surface for that; this file does not add those call
// sites itself.
//
// Wave 2a multi-tenant migration: WebhookSubscription is tenant-scoped
// (src/lib/tenancy/scope-rules.ts). Takes a REQUIRED tenant-scoped
// `db: TenantClient` (src/lib/db-tenant.ts) instead of importing a
// module-level singleton — dependency injection per plan §2. Every caller
// (api/cdr/route.ts, messaging/ingest.ts) already has one from its own
// guard.
export async function emitEvent(db: TenantClient, event: string, payload: object): Promise<void> {
  try {
    const subscriptions = await db.webhookSubscription.findMany({
      where: { active: true, events: { has: event } },
    });

    await Promise.allSettled(
      subscriptions.map((sub) =>
        sendWebhook(sub.url, event, payload, sub.secret || process.env.CRM_WEBHOOK_SECRET || "")
      )
    );
  } catch (err) {
    // Never let a webhook-delivery failure propagate into the caller's own
    // request/response cycle.
    console.error("emitEvent failed:", err);
  }
}
