import { NextResponse } from "next/server";
import { requireStaffSession } from "@/lib/auth-guard";
import { getAmiClient } from "@/lib/ami-client";
import { redactMessagesForSession } from "@/lib/messaging/conversation-access";

export const dynamic = "force-dynamic";

// GET /api/admin/rooms/[id]/activity — turns a Room from a static count
// into an actual supervision surface: each member's live call state and
// queue membership, plus their WhatsApp instance and recent conversation
// previews. Message bodies still go through redactMessagesForSession()
// (a `sensitive` SMS body stays gated by the SmsAccessRequest workflow
// even here — a supervisor already sees sensitive bodies per that
// function's own rule, but the path is identical to every other route
// that returns ChatMessage rows, not a second door).
export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const room = await db.room.findUnique({ where: { id: params.id } });
  if (!room) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const memberIds = (room.memberUserIds as string[]) ?? [];
  const members = await db.user.findMany({
    where: { id: { in: memberIds } },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      extension: { select: { number: true, status: true, lastSeenAt: true } },
      waInstance: { select: { id: true, label: true, simPort: true, status: true, phoneE164: true } },
    },
  });

  // Live channel per member, best-effort — an AMI outage degrades to "no
  // live-call data" rather than failing the whole page.
  const liveChannelsByExtension = new Map<string, { channel: string; state: string | undefined; callerIdNum: string | undefined }>();
  try {
    const ami = getAmiClient();
    await ami.connect();
    const { events } = await ami.sendAndCollect({ Action: "CoreShowChannels" }, "CoreShowChannelsComplete");
    for (const e of events) {
      if (e.Event !== "CoreShowChannel") continue;
      const ext = /^PJSIP\/(\w+)-/.exec(e.Channel ?? "")?.[1];
      if (ext) liveChannelsByExtension.set(ext, { channel: e.Channel!, state: e.ChannelStateDesc, callerIdNum: e.CallerIDNum });
    }
  } catch {
    // AMI unreachable — members render without live-call data.
  }

  // A member's WhatsApp queue isn't just conversations formally claimed via
  // assignedAgentId — the agent's own inbox (GET /api/messaging/conversations)
  // also shows every unassigned conversation on their WaInstance ("up for
  // grabs", one agent per SIM port — see WaInstance.assignedUserId). Filtering
  // this room view on assignedAgentId alone hid that whole queue: a member
  // with 10 conversations on their line but only 1 formally claimed showed
  // as "1 conversation" here, understating their actual WhatsApp activity.
  const memberWaInstanceIds = members.map((m) => m.waInstance?.id).filter((id): id is string => !!id);

  const conversations = await db.conversation.findMany({
    where: {
      OR: [
        { assignedAgentId: { in: memberIds } },
        ...(memberWaInstanceIds.length > 0
          ? [{ waInstanceId: { in: memberWaInstanceIds }, assignedAgentId: null }]
          : []),
      ],
    },
    include: {
      contact: { select: { id: true, numberE164: true, displayName: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 3, include: { accessRequests: { where: { requestedById: guard.session.user.id } } } },
    },
    orderBy: { lastMessageAt: "desc" },
    take: 50,
  });

  const conversationPreviews = conversations.map((c) => {
    const redacted = redactMessagesForSession(
      c.messages.map((m) => ({
        id: m.id,
        conversationId: c.id,
        direction: m.direction,
        body: m.body,
        mediaUrl: m.mediaUrl,
        mediaMimeType: m.mediaMimeType,
        mediaKind: m.mediaKind,
        deliveryStatus: m.deliveryStatus,
        sensitive: m.sensitive,
        createdAt: m.createdAt,
      })),
      guard.session.user.role as "ADMIN" | "SUPERVISOR",
      new Map(c.messages.map((m) => [m.id, m.accessRequests]))
    );
    return {
      id: c.id,
      channel: c.channel,
      assignedAgentId: c.assignedAgentId,
      contact: c.contact,
      lastMessageAt: c.lastMessageAt,
      unreadCount: c.unreadCount,
      recentMessages: redacted,
    };
  });

  return NextResponse.json({
    members: members.map((m) => ({
      id: m.id,
      name: m.name,
      email: m.email,
      role: m.role,
      extension: m.extension
        ? {
            number: m.extension.number,
            status: m.extension.status,
            liveChannel: liveChannelsByExtension.get(m.extension.number) ?? null,
          }
        : null,
      waInstance: m.waInstance,
    })),
    conversations: conversationPreviews,
  });
}
