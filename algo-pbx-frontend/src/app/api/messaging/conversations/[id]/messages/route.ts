import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { requireSession } from "@/lib/auth-guard";
import {
  canAccessConversation,
  canSendOnConversation,
  redactMessagesForSession,
  type Role,
} from "@/lib/messaging/conversation-access";
import { getProvider } from "@/lib/messaging/registry";
import { emitEvent } from "@/lib/emit-event";
import { recordActivity, truncateBody } from "@/lib/crm/activity";
import { syncConversationHistory } from "@/lib/messaging/history-sync";

export const dynamic = "force-dynamic";

// GET /api/messaging/conversations/[id]/messages — the chat thread, polled
// every 5s by src/components/chat/ChatThread. Every response is filtered
// through redactMessagesForSession() (src/lib/messaging/conversation-
// access.ts) — a sensitive SMS body NEVER leaves this route unless the
// caller's own approved (non-expired) SmsAccessRequest says otherwise.
export async function GET(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { role, id: userId } = guard.session.user;
  const { db } = guard;

  // Pagination for "scroll up to load earlier" (WhatsApp-Web style). No
  // `before` = the most recent page; `before=<iso>` = the page just older
  // than that. Page size caps at 300.
  const beforeParam = request.nextUrl.searchParams.get("before");
  const before = beforeParam ? new Date(beforeParam) : null;
  const pageSize = Math.min(
    300,
    Math.max(20, Number(request.nextUrl.searchParams.get("limit")) || (before ? 80 : 200))
  );

  const conversation = await db.conversation.findUnique({
    where: { id: params.id },
    include: { contact: { select: { id: true, numberE164: true, displayName: true } } },
  });
  if (!conversation) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!canAccessConversation({ role: role as Role, userId, assignedAgentId: conversation.assignedAgentId })) {
    // 404, not 403 — a conversation assigned to someone else should not
    // even confirm its own existence to an agent who can't see it.
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Pull backlog from the provider (rate-limited internally) so the thread
  // shows real history + media the push webhook never delivered. Fire and
  // forget on the first (unpaginated) load only — the first sync can take a
  // minute (it downloads media bytes for hundreds of old messages) and each
  // 5s poll picks up whatever has landed so far.
  if (conversation.channel === "WHATSAPP" && !before) {
    void syncConversationHistory(db, conversation.id).catch(() => undefined);
  }

  const [page, myRequests] = await Promise.all([
    db.chatMessage.findMany({
      where: {
        conversationId: conversation.id,
        ...(before ? { createdAt: { lt: before } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: pageSize,
    }),
    db.smsAccessRequest.findMany({
      where: { requestedById: userId, message: { conversationId: conversation.id } },
      select: { messageId: true, status: true, expiresAt: true, createdAt: true },
    }),
  ]);

  const hasMore = page.length === pageSize;
  const messages = page.reverse();

  const requestsByMessageId = new Map<string, typeof myRequests>();
  for (const r of myRequests) {
    const list = requestsByMessageId.get(r.messageId) ?? [];
    list.push(r);
    requestsByMessageId.set(r.messageId, list);
  }

  // Mark read on the viewing agent's own poll — best-effort, not gated on
  // access (an admin/supervisor viewing also clears it).
  if (conversation.unreadCount > 0) {
    await db.conversation.update({ where: { id: conversation.id }, data: { unreadCount: 0 } }).catch(() => undefined);
  }

  return NextResponse.json({
    conversationId: conversation.id,
    channel: conversation.channel,
    contact: conversation.contact,
    hasMore,
    oldestCreatedAt: messages[0]?.createdAt ?? null,
    messages: redactMessagesForSession(messages, role as Role, requestsByMessageId),
  });
}

const SendSchema = z.object({
  text: z.string().min(1).max(4096),
});

// POST /api/messaging/conversations/[id]/messages — send an outbound
// message on this thread via whatever provider its WaInstance (or, for
// SMS, DinstarSmsProvider directly) is configured with. An unassigned
// conversation is implicitly CLAIMED by the sender — see conversation-
// access.ts's policy comment for why that's the chosen ownership rule
// with only 4 shared WaInstances.
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { role, id: userId } = guard.session.user;
  const { db } = guard;

  const parsed = SendSchema.safeParse(await request.json().catch(() => null));
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

  let providerKind: "OPENWA" | "META_CLOUD" | "DINSTAR_SMS";
  let instanceId: string;
  if (conversation.channel === "SMS") {
    if (!conversation.waInstance) {
      return NextResponse.json({ error: "This SMS conversation has no SIM port assigned." }, { status: 409 });
    }
    providerKind = "DINSTAR_SMS";
    instanceId = String(conversation.waInstance.simPort);
  } else {
    if (!conversation.waInstance) {
      return NextResponse.json({ error: "This WhatsApp conversation has no instance assigned." }, { status: 409 });
    }
    // A calls-only instance (MessageProviderKind.NONE) should never reach
    // this point — conversations/route.ts already refuses to create one
    // against it — but guard here too rather than trusting that
    // invariant, since getProvider("NONE") has no adapter and would throw.
    if (conversation.waInstance.provider === "NONE") {
      return NextResponse.json({ error: "This SIM port is calls-only and has no WhatsApp identity." }, { status: 409 });
    }
    providerKind = conversation.waInstance.provider as "OPENWA" | "META_CLOUD";
    if (providerKind === "OPENWA") {
      if (!conversation.waInstance.openwaSessionId) {
        return NextResponse.json({ error: "This WhatsApp instance has no active OpenWA session. Re-pair it in /admin/whatsapp." }, { status: 409 });
      }
      instanceId = conversation.waInstance.openwaSessionId;
    } else {
      instanceId = conversation.waInstance.id;
    }
  }

  // MessageProvider.sendText's toE164 is always E.164-with-plus regardless
  // of channel — each adapter converts to its own wire format internally
  // (e164ToWaId for WhatsApp adapters, normalizeToE164 passthrough for
  // Dinstar). See src/lib/messaging/types.ts's SendTextInput comment.
  const provider = getProvider(providerKind);
  const result = await provider.sendText({ instanceId, toE164: conversation.contact.numberE164, text: parsed.data.text });

  // No `tenantId` — force-injected at runtime by the TenantClient
  // extension (see src/lib/crm/activity.ts's comment on the same pattern).
  const message = await db.chatMessage.create({
    data: {
      conversationId: conversation.id,
      direction: "OUTBOUND",
      body: parsed.data.text,
      providerMessageId: result.providerMessageId,
      // OpenWA returns its waMessageId as `messageId`; storing it here lets
      // history-sync dedupe this send against the backlog pull.
      waMessageId: result.providerMessageId,
      deliveryStatus: result.status,
      sensitive: false,
    } as unknown as Prisma.ChatMessageUncheckedCreateInput,
  });

  // Unified CRM timeline (S2) — one activity per outbound message, keyed on
  // the ChatMessage id so it is idempotent.
  await recordActivity(
    {
      type: conversation.channel === "SMS" ? "SMS" : "WHATSAPP",
      summary: `Sent: ${truncateBody(parsed.data.text, "(message)")}`,
      refId: message.id,
      occurredAt: message.createdAt,
      contactId: conversation.contactId,
      actorId: userId,
    },
    db,
  );

  // Claim an unassigned conversation on first send — see file header.
  if (!conversation.assignedAgentId && (role === "AGENT" || role === "SUPERVISOR" || role === "ADMIN")) {
    await db.conversation
      .update({ where: { id: conversation.id }, data: { assignedAgentId: userId, lastMessageAt: new Date() } })
      .catch(() => undefined);
  } else {
    await db.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: new Date() } }).catch(() => undefined);
  }

  // Feature B1 (2026-08-31) — the SAME "claim on first send" behavior as
  // above, but for Contact.ownerId (a different field on a different
  // model: Conversation.assignedAgentId is per-channel-thread ownership,
  // Contact.ownerId is the whole-contact relationship). A chat reply is a
  // "meaningful interaction" exactly like an answered call (see the mirror
  // of this in POST /api/cdr's ingest handler). Independent of whether the
  // conversation itself was already assigned to someone else — a contact
  // can be unowned while its conversation already has an assignee from an
  // earlier send by an agent who never went on to own the contact.
  if (!conversation.contact.ownerId) {
    const claimed = await db.contact.updateMany({
      where: { id: conversation.contactId, ownerId: null },
      data: { ownerId: userId },
    });
    if (claimed.count > 0) {
      await db.auditLog
        .create({
          data: {
            action: "contact.auto_assign",
            actorId: userId,
            targetId: conversation.contactId,
            metadata: { via: "chat_reply", conversationId: conversation.id },
          } as unknown as Prisma.AuditLogUncheckedCreateInput,
        })
        .catch(() => undefined);
    }
  }

  if (result.status === "failed") {
    return NextResponse.json({ error: result.error ?? "Send failed", message }, { status: 502 });
  }

  void emitEvent(db, "message.sent", {
    conversationId: conversation.id,
    channel: conversation.channel,
    toE164: conversation.contact.numberE164,
    body: parsed.data.text,
  });

  return NextResponse.json({ message });
}
