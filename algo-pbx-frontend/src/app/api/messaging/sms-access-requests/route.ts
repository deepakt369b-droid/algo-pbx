import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";
import { canAccessConversation, type Role } from "@/lib/messaging/conversation-access";

export const dynamic = "force-dynamic";

// POST /api/messaging/sms-access-requests — an agent asks an admin to
// unlock one sensitive (OTP-shaped) SMS. Only valid for a message that is
// actually flagged sensitive and belongs to a conversation this agent can
// otherwise access (the sensitive-body gate is additional to, not instead
// of, normal conversation access — an agent can't request access to a
// thread they can't see at all).
const RequestSchema = z.object({
  messageId: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { role, id: userId } = guard.session.user;

  const parsed = RequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }

  const message = await db.chatMessage.findUnique({
    where: { id: parsed.data.messageId },
    include: { conversation: true },
  });
  if (!message || !message.sensitive) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (
    !canAccessConversation({
      role: role as Role,
      userId,
      assignedAgentId: message.conversation.assignedAgentId,
    })
  ) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Avoid piling up duplicate PENDING rows for the same agent/message —
  // return the existing one instead of creating a second.
  const existingPending = await db.smsAccessRequest.findFirst({
    where: { messageId: message.id, requestedById: userId, status: "PENDING" },
  });
  if (existingPending) return NextResponse.json({ request: existingPending });

  const created = await db.smsAccessRequest.create({
    data: { messageId: message.id, requestedById: userId, status: "PENDING" },
  });

  await db.auditLog.create({
    data: {
      action: "sms_access.request",
      actorId: userId,
      targetId: message.id,
      metadata: { conversationId: message.conversationId },
    },
  });

  return NextResponse.json({ request: created }, { status: 201 });
}
