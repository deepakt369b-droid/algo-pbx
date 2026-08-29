import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";
import { normalizeToE164 } from "@/lib/phone-normalize";
import { findOrCreateConversation } from "@/lib/messaging/ingest";
import { canAccessConversation, type Role } from "@/lib/messaging/conversation-access";

export const dynamic = "force-dynamic";

// GET /api/messaging/conversations — the agent chat panel's conversation
// list (polled every 5s, same pattern as src/components/wallboard.tsx —
// there is no websocket/SSE infra in this codebase to piggyback on).
// AGENT sessions see only conversations assigned to them or unassigned
// ("up for grabs" — see src/lib/messaging/conversation-access.ts's policy
// comment); ADMIN/SUPERVISOR see everything.
export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { role, id: userId } = guard.session.user;

  const mineOnly = request.nextUrl.searchParams.get("mine") === "true";

  const where =
    role === "ADMIN" || role === "SUPERVISOR"
      ? {}
      : mineOnly
        ? { assignedAgentId: userId }
        : { OR: [{ assignedAgentId: userId }, { assignedAgentId: null }] };

  const conversations = await db.conversation.findMany({
    where,
    include: { contact: true },
    orderBy: { lastMessageAt: "desc" },
    take: 100,
  });

  return NextResponse.json({
    conversations: conversations.map((c) => ({
      id: c.id,
      channel: c.channel,
      contact: { id: c.contact.id, numberE164: c.contact.numberE164, displayName: c.contact.displayName },
      assignedAgentId: c.assignedAgentId,
      unreadCount: c.unreadCount,
      lastMessageAt: c.lastMessageAt,
      mine: c.assignedAgentId === userId,
    })),
  });
}

const CreateSchema = z.object({
  numberE164: z.string().min(1),
  channel: z.enum(["WHATSAPP", "SMS"]),
  waInstanceId: z.string().min(1).optional(),
});

// POST /api/messaging/conversations — agent-initiated "start a new
// conversation" (there is otherwise no create path anywhere in the repo:
// the only other conversation.create call site is ingestInboundEvent()'s
// inbound-message path in src/lib/messaging/ingest.ts, only reachable from
// an inbound webhook/poll). Any signed-in staff session may start one, same
// as the send route (POST .../[id]/messages) — starting a thread is no
// more sensitive than replying on an unassigned one, which any AGENT can
// already do per conversation-access.ts's claim-on-send policy.
export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { role, id: userId } = guard.session.user;

  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const e164 = normalizeToE164(parsed.data.numberE164);
  if (!e164) {
    return NextResponse.json({ error: "Not a valid phone number" }, { status: 400 });
  }

  const { channel } = parsed.data;

  // SMS has no per-instance session (Dinstar's compound-unique row is
  // always waInstanceId: null — see ingest.ts's findOrCreateConversation
  // comment); WhatsApp requires resolving to a specific paired SIM
  // identity. An explicit waInstanceId always wins; otherwise fall back to
  // whichever WaInstance is assigned to the requesting agent (one agent
  // per SIM port — see WaInstance.assignedUserId's schema comment), same
  // resolution a WhatsApp-enabled agent's own connection badge relies on.
  let waInstanceId: string | null = null;
  if (channel === "WHATSAPP") {
    if (parsed.data.waInstanceId) {
      const instance = await db.waInstance.findUnique({ where: { id: parsed.data.waInstanceId } });
      if (!instance) {
        return NextResponse.json({ error: "Unknown WhatsApp instance" }, { status: 400 });
      }
      // A "calls-only" port (MessageProviderKind.NONE — see its schema
      // comment) has no messaging identity attached at all; never let one
      // be selected as a WhatsApp conversation's instance, which would
      // fail unhelpfully at send time via getProvider("NONE").
      if (instance.provider === "NONE") {
        return NextResponse.json({ error: "This SIM port is calls-only and has no WhatsApp identity." }, { status: 409 });
      }
      waInstanceId = instance.id;
    } else {
      const instance = await db.waInstance.findUnique({ where: { assignedUserId: userId } });
      if (!instance || instance.provider === "NONE") {
        return NextResponse.json(
          { error: "No WhatsApp instance is assigned to you. Provide waInstanceId or ask an admin to assign one." },
          { status: 409 }
        );
      }
      waInstanceId = instance.id;
    }
  }

  const contact = await db.contact.upsert({
    where: { numberE164: e164 },
    update: {},
    create: { numberE164: e164 },
  });

  const { conversation } = await findOrCreateConversation(contact.id, channel, waInstanceId, {
    assignedAgentId: userId,
  });

  // A reused (not newly created) conversation may already be assigned to
  // someone else — same "invisible to an agent, full stop" rule as every
  // other route on this resource (conversation-access.ts). Don't hand back
  // an id the caller can't actually open.
  if (!canAccessConversation({ role: role as Role, userId, assignedAgentId: conversation.assignedAgentId })) {
    return NextResponse.json({ error: "A conversation for this number already exists and is assigned to another agent." }, { status: 409 });
  }

  return NextResponse.json({ conversationId: conversation.id }, { status: 201 });
}
