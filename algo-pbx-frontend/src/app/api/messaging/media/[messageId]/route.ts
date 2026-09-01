import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";
import { canAccessConversation, type Role } from "@/lib/messaging/conversation-access";
import * as openwa from "@/lib/messaging/openwa-client";
import { e164ToWaId } from "@/lib/messaging/wa-id";

export const dynamic = "force-dynamic";

// GET /api/messaging/media/[messageId] — streams the bytes for a WhatsApp
// media message (voice note, image, video, document, sticker). OpenWA stores
// the payload; this proxies it through our own auth check so the browser
// never talks to the sidecar and no cross-origin / expiring URL leaks.
//
// A sensitive message's media is refused the same way its body is redacted
// (see conversation-access.ts) unless the caller has an approved request.
export async function GET(_request: NextRequest, { params }: { params: { messageId: string } }) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { role, id: userId } = guard.session.user;

  const message = await db.chatMessage.findUnique({
    where: { id: params.messageId },
    include: {
      conversation: { include: { contact: true, waInstance: true } },
    },
  });
  if (!message || !message.mediaKind) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const conv = message.conversation;
  if (!canAccessConversation({ role: role as Role, userId, assignedAgentId: conv.assignedAgentId })) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (message.sensitive && role !== "ADMIN" && role !== "SUPERVISOR") {
    const approved = await db.smsAccessRequest.findFirst({
      where: {
        messageId: message.id,
        requestedById: userId,
        status: "APPROVED",
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { id: true },
    });
    if (!approved) return NextResponse.json({ error: "Access required" }, { status: 403 });
  }

  const cacheHeaders = {
    // Per-message, auth-checked; a shared cache must never serve it onward.
    "Cache-Control": "private, max-age=86400",
  };

  // Primary source: the base64 we captured at ingest (OpenWA's own /media
  // sub-endpoint 404s for received media it never archived).
  if (message.mediaData) {
    const bytes = Buffer.from(message.mediaData, "base64");
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        ...cacheHeaders,
        "Content-Type": message.mediaMimeType || "application/octet-stream",
        "Content-Length": String(bytes.length),
      },
    });
  }

  // Fallback: over the ingest size cap, or a legacy row — try the sidecar.
  const sessionId = conv.waInstance?.openwaSessionId;
  const waId = e164ToWaId(conv.contact.numberE164);
  const waMessageId = message.waMessageId ?? message.providerMessageId;
  if (!sessionId || !waId || !waMessageId) {
    return NextResponse.json({ error: "Media unavailable" }, { status: 404 });
  }
  try {
    const { bytes, contentType } = await openwa.getMessageMedia(sessionId, `${waId}@c.us`, waMessageId);
    return new NextResponse(new Uint8Array(bytes), {
      status: 200,
      headers: {
        ...cacheHeaders,
        "Content-Type": message.mediaMimeType || contentType || "application/octet-stream",
        "Content-Length": String(bytes.length),
      },
    });
  } catch {
    return NextResponse.json({ error: "Media unavailable" }, { status: 404 });
  }
}
