import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";

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
