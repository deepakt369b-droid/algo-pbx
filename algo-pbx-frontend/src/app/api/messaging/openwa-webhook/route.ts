import { timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getProvider } from "@/lib/messaging/registry";
import { ingestInboundEvent } from "@/lib/messaging/ingest";

export const dynamic = "force-dynamic";

// POST /api/messaging/openwa-webhook — inbound WhatsApp events pushed by
// the OpenWA sidecar (docker-compose.yml's `openwa` service,
// WEBHOOK_URL=http://web:3000/api/messaging/openwa-webhook). Verified with
// a shared-secret header (OPENWA_WEBHOOK_SECRET) compared in constant time
// — mirrors the timingSafeEqual pattern already used by
// src/app/api/cdr/route.ts for its own server-to-server ingest secret,
// rather than inventing a second convention. A HUMAN MUST VERIFY the
// actual header name OpenWA sends the shared secret in; this assumes
// `x-webhook-secret`, documented as such at the top of
// src/lib/messaging/openwa-provider.ts's UNVERIFIED block.
function isAuthorized(request: NextRequest): boolean {
  const expected = process.env.OPENWA_WEBHOOK_SECRET;
  if (!expected) return false;
  const provided = request.headers.get("x-webhook-secret") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null);
  if (!payload) return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });

  const provider = getProvider("OPENWA");
  const events = provider.parseInbound(payload);

  for (const event of events) {
    // Resolve the OpenWA session id the adapter reported back to a
    // WaInstance row — instanceRef is the WaInstance.id itself (it's used
    // as the OpenWA session name, see openwa-provider.ts), so this is a
    // direct lookup, not a search.
    const waInstance = event.instanceRef
      ? await db.waInstance.findUnique({ where: { id: event.instanceRef } })
      : null;
    await ingestInboundEvent(event, "WHATSAPP", waInstance?.id ?? null);
  }

  return NextResponse.json({ ok: true, ingested: events.length });
}
