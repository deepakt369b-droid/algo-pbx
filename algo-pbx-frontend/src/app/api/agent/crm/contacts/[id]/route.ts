import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";
import { canWriteContact } from "@/lib/contact-ownership";

export const dynamic = "force-dynamic";

// GET /api/agent/crm/contacts/[id] — contact detail + notes + tasks +
// dispositions + a merged calls/messages timeline, for the agent console
// (P3). Session-authenticated, unlike /api/crm/contacts/[id]/activity
// (Bearer-key only). Uses CallDetailRecord.callerNumberE164 (indexed,
// P2) instead of that route's pre-existing approach of pulling the last
// 2000 CDRs and normalizing every one in-process — correct for any
// contact regardless of how far back their calls go, not just the most
// recent ~2000 system-wide.
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;

  const contact = await db.contact.findUnique({
    where: { id: params.id },
    include: {
      owner: { select: { id: true, name: true } },
      notes: { include: { author: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" } },
      tasks: { include: { assignee: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" } },
      dispositions: { include: { agent: { select: { id: true, name: true } } }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!contact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const [dncEntry, calls, conversations] = await Promise.all([
    db.doNotCallEntry.findUnique({ where: { numberE164: contact.numberE164 } }),
    db.callDetailRecord.findMany({
      where: { OR: [{ callerNumberE164: contact.numberE164 }, { destination: contact.numberE164 }] },
      orderBy: { startedAt: "desc" },
      take: 100,
    }),
    db.conversation.findMany({ where: { contactId: contact.id } }),
  ]);

  const messages = await db.chatMessage.findMany({
    where: { conversationId: { in: conversations.map((c) => c.id) } },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  const timeline = [
    ...calls.map((c) => ({
      type: "call" as const,
      timestamp: c.startedAt,
      uniqueId: c.uniqueId,
      direction: c.direction,
      disposition: c.disposition,
      durationSec: c.durationSec,
      agentExtension: c.agentExtension,
    })),
    ...messages.map((m) => ({
      type: "message" as const,
      timestamp: m.createdAt,
      channel: conversations.find((c) => c.id === m.conversationId)?.channel,
      direction: m.direction,
      // Same rule as every other agent-facing chat surface: a sensitive
      // (OTP-shaped) body never leaves the API unredacted.
      body: m.sensitive ? null : m.body,
      sensitive: m.sensitive,
    })),
  ].sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  return NextResponse.json({ contact: { ...contact, dncBlocked: Boolean(dncEntry) }, timeline });
}

const PatchSchema = z.object({
  displayName: z.string().max(200).optional(),
  email: z.string().email().nullable().optional(),
  company: z.string().max(200).nullable().optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  ownerId: z.string().nullable().optional(),
});

export async function PATCH(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { role, id: userId } = guard.session.user;

  const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const existing = await db.contact.findUnique({ where: { id: params.id }, include: { owner: { select: { id: true, name: true } } } });
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Feature B2 — the core conflict-prevention requirement, server-side.
  // Client-side (contact-detail.tsx) already hides the write UI for a
  // non-owner; this is the independent enforcement that actually matters.
  if (!canWriteContact({ role: role as "AGENT" | "SUPERVISOR" | "ADMIN", userId, ownerId: existing.ownerId })) {
    return NextResponse.json(
      { error: `This contact is owned by ${existing.owner?.name ?? "another agent"}. Request a transfer to edit it.` },
      { status: 403 }
    );
  }

  // Reassignment ("who owns this contact") goes through the transfer-
  // request approve flow (POST/PATCH /api/agent/crm/transfer-requests) so
  // it's audited and, for a currently-owned contact, consent-gated — not
  // through this general-purpose field PATCH. An AGENT silently overwriting
  // ownerId here would be exactly the conflict-prevention hole B2/B3 exist
  // to close; SUPERVISOR/ADMIN keep the direct-reassign shortcut (B5's
  // admin reassign action also lands here).
  if ("ownerId" in parsed.data && role === "AGENT") {
    return NextResponse.json(
      { error: "Agents cannot reassign ownership directly — use Request transfer." },
      { status: 403 }
    );
  }

  const contact = await db.contact.update({ where: { id: params.id }, data: parsed.data });
  return NextResponse.json({ contact });
}
