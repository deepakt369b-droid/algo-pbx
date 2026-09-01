import type { ActivityType, Prisma, PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";

type Db = PrismaClient | Prisma.TransactionClient;

// One row per real-world event on the unified CRM timeline (S2). Idempotent
// via Activity's @@unique([type, refId]) — a duplicate ingest / a re-run
// backfill / a double webhook all no-op. `refId` is the source row's natural
// id (cdr uniqueId, chatMessage id, note id, task id, deal id).
export async function recordActivity(
  input: {
    type: ActivityType;
    summary: string;
    refId: string | null;
    occurredAt?: Date;
    contactId?: string | null;
    dealId?: string | null;
    actorId?: string | null;
  },
  client: Db = db,
): Promise<void> {
  if (!input.contactId && !input.dealId) return; // nothing to hang it on
  const data = {
    type: input.type,
    summary: input.summary.slice(0, 500),
    refId: input.refId,
    occurredAt: input.occurredAt ?? new Date(),
    contactId: input.contactId ?? null,
    dealId: input.dealId ?? null,
    actorId: input.actorId ?? null,
  };
  try {
    if (input.refId != null) {
      await client.activity.upsert({
        where: { type_refId: { type: input.type, refId: input.refId } },
        update: {},
        create: data,
      });
    } else {
      await client.activity.create({ data });
    }
  } catch (err) {
    // A timeline row must never break the call/message/note write it hangs
    // off of. The unique-constraint race (two ingests of the same event)
    // lands here too and is a no-op, which is correct.
    if (
      !(err instanceof Error) ||
      !err.message.includes("Unique constraint")
    ) {
      console.error("[crm/activity] recordActivity failed", err);
    }
  }
}

export function truncateBody(body: string | null | undefined, fallback = "(no text)"): string {
  const t = (body ?? "").trim();
  return t.length ? t.slice(0, 140) : fallback;
}
