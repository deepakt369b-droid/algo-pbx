import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// GET/POST /api/agent/crm/transfer-requests — Feature B3, the one-contact-
// one-owner conflict resolution flow. Mirrors SmsAccessRequest's request ->
// approve/decline shape (see prisma/schema.prisma's ContactTransferRequest
// comment and src/app/api/messaging/sms-access-requests/route.ts) rather
// than inventing a new pattern. No push infra exists in this codebase (see
// src/components/chat/conversation-list.tsx's own comment) — "notifies
// owner + manager" realistically means: a PENDING row this GET surfaces to
// a polling UI (the current owner sees requests against their own
// contacts; staff see everything; a requester sees their own to know it
// landed).
const CreateSchema = z.object({ contactId: z.string().min(1) });

export async function POST(request: NextRequest) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { id: userId } = guard.session.user;

  const parsed = CreateSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const contact = await db.contact.findUnique({ where: { id: parsed.data.contactId } });
  if (!contact) return NextResponse.json({ error: "Not found" }, { status: 404 });

  if (!contact.ownerId) {
    return NextResponse.json({ error: "This contact is unowned — no transfer needed, it will be claimed on your next interaction with it." }, { status: 409 });
  }
  if (contact.ownerId === userId) {
    return NextResponse.json({ error: "You already own this contact." }, { status: 409 });
  }

  // Avoid piling up duplicate PENDING rows for the same requester/contact —
  // same dedupe rule as sms-access-requests/route.ts.
  const existingPending = await db.contactTransferRequest.findFirst({
    where: { contactId: contact.id, requestedById: userId, status: "PENDING" },
  });
  if (existingPending) return NextResponse.json({ request: existingPending });

  const created = await db.contactTransferRequest.create({
    data: {
      contactId: contact.id,
      requestedById: userId,
      currentOwnerId: contact.ownerId,
    },
    include: {
      requestedBy: { select: { id: true, name: true } },
      currentOwner: { select: { id: true, name: true } },
      contact: { select: { id: true, displayName: true, numberE164: true } },
    },
  });

  await db.auditLog.create({
    data: {
      action: "contact.transfer_request",
      actorId: userId,
      targetId: contact.id,
      metadata: { requestId: created.id, currentOwnerId: contact.ownerId },
    },
  });

  return NextResponse.json({ request: created }, { status: 201 });
}

// GET — polling surface for the requests relevant to the caller:
//   ?scope=incoming  — requests against contacts THIS user currently owns
//                       (or, for SUPERVISOR/ADMIN, every pending request —
//                       the "manager" half of "notifies owner + manager")
//   ?scope=mine       — requests THIS user made, any status (default)
export async function GET(request: NextRequest) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const { role, id: userId } = guard.session.user;

  const { searchParams } = new URL(request.url);
  const scope = searchParams.get("scope") === "incoming" ? "incoming" : "mine";

  const where =
    scope === "incoming"
      ? role === "SUPERVISOR" || role === "ADMIN"
        ? { status: "PENDING" as const }
        : { currentOwnerId: userId, status: "PENDING" as const }
      : { requestedById: userId };

  const requests = await db.contactTransferRequest.findMany({
    where,
    include: {
      requestedBy: { select: { id: true, name: true } },
      currentOwner: { select: { id: true, name: true } },
      contact: { select: { id: true, displayName: true, numberE164: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  return NextResponse.json({ requests });
}
