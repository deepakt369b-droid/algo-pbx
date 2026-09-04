import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/auth-guard";
import { canSendOnConversation, type Role } from "@/lib/messaging/conversation-access";
import { OpenWaProvider } from "@/lib/messaging/openwa-provider";
import { recordActivity } from "@/lib/crm/activity";
import { emitEvent } from "@/lib/emit-event";

export const dynamic = "force-dynamic";

// ~5 MB of base64 (~3.7 MB of audio) — a WhatsApp voice note this long is
// already unusual; anything bigger is almost certainly a mistake.
const MAX_BASE64_LEN = 5_000_000;

const Schema = z.object({
  // Raw base64 (no data: prefix) of the recorded audio.
  base64: z.string().min(16).max(MAX_BASE64_LEN),
  mimeType: z.string().min(3).max(120),
  durationSec: z.number().int().nonnegative().max(600).optional(),
});

// POST /api/messaging/conversations/[id]/voice — send a WhatsApp voice note
// recorded in the browser (MediaRecorder -> base64). WhatsApp only; OpenWA
// transcodes to opus/ogg and sends it as a ptt bubble.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { role, id: userId } = guard.session.user;
  const { db } = guard;

  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const conversation = await db.conversation.findUnique({
    where: { id: params.id },
    include: { contact: true, waInstance: true },
  });
  if (!conversation) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!canSendOnConversation({ role: role as Role, userId, assignedAgentId: conversation.assignedAgentId })) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (conversation.channel !== "WHATSAPP") {
    return NextResponse.json({ error: "Voice notes are WhatsApp-only." }, { status: 409 });
  }
  const inst = conversation.waInstance;
  if (!inst || inst.provider !== "OPENWA" || !inst.openwaSessionId) {
    return NextResponse.json(
      { error: "This WhatsApp instance has no active OpenWA session. Re-pair it in /admin/whatsapp." },
      { status: 409 }
    );
  }

  const provider = new OpenWaProvider();
  const result = await provider.sendVoice({
    instanceId: inst.openwaSessionId,
    toE164: conversation.contact.numberE164,
    base64: parsed.data.base64,
    mimeType: parsed.data.mimeType,
  });

  // No `tenantId` — force-injected at runtime by the TenantClient
  // extension (see src/lib/crm/activity.ts's comment on the same pattern).
  const message = await db.chatMessage.create({
    data: {
      conversationId: conversation.id,
      direction: "OUTBOUND",
      body: null,
      mediaKind: "voice",
      mediaMimeType: parsed.data.mimeType,
      // We already hold the bytes — stash them (capped) so the bubble plays
      // back immediately without a round-trip to the sidecar.
      mediaData: parsed.data.base64.length <= 1_400_000 ? parsed.data.base64 : null,
      providerMessageId: result.providerMessageId,
      waMessageId: result.providerMessageId,
      deliveryStatus: result.status,
      sensitive: false,
    } as unknown as Prisma.ChatMessageUncheckedCreateInput,
  });
  await db.chatMessage
    .update({ where: { id: message.id }, data: { mediaUrl: `/api/messaging/media/${message.id}` } })
    .catch(() => undefined);

  if (!conversation.assignedAgentId) {
    await db.conversation
      .update({ where: { id: conversation.id }, data: { assignedAgentId: userId, lastMessageAt: new Date() } })
      .catch(() => undefined);
  } else {
    await db.conversation
      .update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } })
      .catch(() => undefined);
  }
  if (!conversation.contact.ownerId) {
    await db.contact
      .updateMany({ where: { id: conversation.contactId, ownerId: null }, data: { ownerId: userId } })
      .catch(() => undefined);
  }

  await recordActivity(
    {
      type: "WHATSAPP",
      summary: "Sent: 🎤 Voice message",
      refId: message.id,
      occurredAt: message.createdAt,
      contactId: conversation.contactId,
      actorId: userId,
    },
    db,
  );

  if (result.status === "failed") {
    return NextResponse.json({ error: result.error ?? "Send failed", message }, { status: 502 });
  }
  void emitEvent(db, "message.sent", { conversationId: conversation.id, channel: "WHATSAPP" });
  return NextResponse.json({ ok: true, messageId: message.id });
}
