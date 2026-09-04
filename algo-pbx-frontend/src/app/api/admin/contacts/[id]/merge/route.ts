import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { requireStaffSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// POST /api/admin/contacts/[id]/merge — real merge, not a documented
// manual-only path (see CLAUDE.md task #2's (a)/(b) choice: chose (a)).
// params.id is the WINNER (the row that survives); body.loserId is the
// row being absorbed and deleted. numberE164 stays the winner's — the
// caller already knows both numbers before merging, so there's no
// ambiguity to resolve here.
//
// ContactNote/ContactTask/CallDisposition all have a plain (non-unique)
// contactId FK, so a bulk updateMany can safely repoint every one of the
// loser's rows onto the winner. Conversation is different: it carries
// @@unique([contactId, channel, waInstanceId]), so if both contacts
// already have an open thread on the same channel/WaInstance, updating
// the loser's row would collide. Handled per-row below — see that
// section for the (documented, deliberate) simplification: a colliding
// loser conversation is dropped rather than having its message history
// interleaved into the winner's, which would need real merge-order logic
// this feature doesn't need to solve today.
const MergeSchema = z.object({ loserId: z.string().min(1) });

function humanizeZodError(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return "Invalid request.";
  const path = first.path.length ? `${first.path.join(".")}: ` : "";
  return `${path}${first.message}`;
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const parsed = MergeSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: humanizeZodError(parsed.error) }, { status: 400 });
  }
  const winnerId = params.id;
  const loserId = parsed.data.loserId;
  if (winnerId === loserId) {
    return NextResponse.json({ error: "Can't merge a contact into itself." }, { status: 400 });
  }

  const [winner, loser] = await Promise.all([
    db.contact.findUnique({ where: { id: winnerId } }),
    db.contact.findUnique({ where: { id: loserId } }),
  ]);
  if (!winner) return NextResponse.json({ error: "The contact to keep was not found." }, { status: 404 });
  if (!loser) return NextResponse.json({ error: "The contact to merge in was not found." }, { status: 404 });

  let droppedConversations = 0;
  await db.$transaction(async (tx) => {
    await tx.contactNote.updateMany({ where: { contactId: loserId }, data: { contactId: winnerId } });
    await tx.contactTask.updateMany({ where: { contactId: loserId }, data: { contactId: winnerId } });
    await tx.callDisposition.updateMany({ where: { contactId: loserId }, data: { contactId: winnerId } });

    const loserConversations = await tx.conversation.findMany({ where: { contactId: loserId } });
    for (const conv of loserConversations) {
      try {
        await tx.conversation.update({ where: { id: conv.id }, data: { contactId: winnerId } });
      } catch {
        // Winner already has a conversation on this (channel, waInstance) —
        // the unique constraint rejected the repoint. Drop the loser's
        // duplicate thread rather than fail the whole merge; its messages
        // stay attached to the (about to be deleted) loser row and are
        // lost. Flagged in the response so the admin can see it happened.
        await tx.conversation.delete({ where: { id: conv.id } });
        droppedConversations++;
      }
    }

    await tx.contact.delete({ where: { id: loserId } });

    // Union tags rather than letting the winner's overwrite the loser's —
    // both rows may carry genuinely distinct labels worth keeping.
    const mergedTags = Array.from(new Set([...winner.tags, ...loser.tags]));
    await tx.contact.update({
      where: { id: winnerId },
      data: {
        tags: mergedTags,
        email: winner.email ?? loser.email ?? undefined,
        company: winner.company ?? loser.company ?? undefined,
        ownerId: winner.ownerId ?? loser.ownerId ?? undefined,
      },
    });

    // No `tenantId` — force-injected at runtime by the TenantClient
    // extension (see src/lib/crm/activity.ts's comment on the same pattern).
    await tx.auditLog.create({
      data: {
        action: "contact.merge",
        actorId: guard.session.user.id,
        targetId: winnerId,
        metadata: { winnerId, loserId, winnerNumber: winner.numberE164, loserNumber: loser.numberE164, droppedConversations },
      } as unknown as Prisma.AuditLogUncheckedCreateInput,
    });
  });

  const merged = await db.contact.findUnique({ where: { id: winnerId } });
  return NextResponse.json({ contact: merged, droppedConversations });
}
