import type { ActivityType, Prisma } from "@prisma/client";
import type { TenantClient } from "@/lib/db-tenant";

// One row per real-world event on the unified CRM timeline (S2). Idempotent
// via Activity's @@unique([tenantId, type, refId]) (tenant-composite since
// wave 1 — plan §1) — a duplicate ingest / a re-run backfill / a double
// webhook all no-op. `refId` is the source row's natural id (cdr uniqueId,
// chatMessage id, note id, task id, deal id).
//
// Wave 2a multi-tenant migration: `client` is now a REQUIRED tenant-scoped
// client (`TenantClient` from src/lib/db-tenant.ts), not a raw
// PrismaClient/TransactionClient with a module-level `db` default. Every
// caller of this function already has one from its own guard (see
// src/lib/crm/deals.ts, src/lib/messaging/ingest.ts) — dependency injection
// per plan §2, not a module-level singleton.
//
// The old upsert keyed on the bare `type_refId` compound unique, which no
// longer exists (it's `tenantId_type_refId` now). Rather than require every
// caller to also hand this function a raw tenantId string just to build that
// literal compound-key object (which `TenantClient` deliberately does not
// expose — the whole point of the extension is that callers never see the
// raw tenantId), this does a plain `findFirst` (tenant-filtered
// automatically by the `TenantClient` extension) followed by `update`/
// `create`. The `err.message.includes("Unique constraint")` catch below
// still absorbs the rare concurrent-race duplicate, so idempotency is
// preserved even though the lookup is now two calls instead of one atomic
// upsert.
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
  client: TenantClient,
): Promise<void> {
  if (!input.contactId && !input.dealId) return; // nothing to hang it on
  // Deliberately does NOT include `tenantId` — this file (unlike
  // dinstar/site-cutover.ts, messaging/ingest.ts) never sees the raw
  // tenantId at all, only the opaque `TenantClient`. The extension's
  // `$allOperations` hook (src/lib/db-tenant.ts) force-injects the correct
  // `tenantId` into every `create` at RUNTIME regardless of what's in
  // `data` (see `injectCreateData()` in scope-rules.ts: "overrides anything
  // the caller passed") — but Prisma's generated `ActivityUncheckedCreateInput`
  // type has no way to know that a `$extends` wrapper does this, so it
  // still statically requires a `tenantId: string` field. The
  // double-cast below tells the compiler to trust the runtime guarantee;
  // the field is never actually read from here.
  const data = {
    type: input.type,
    summary: input.summary.slice(0, 500),
    refId: input.refId,
    occurredAt: input.occurredAt ?? new Date(),
    contactId: input.contactId ?? null,
    dealId: input.dealId ?? null,
    actorId: input.actorId ?? null,
  } as unknown as Prisma.ActivityUncheckedCreateInput;
  try {
    if (input.refId != null) {
      const existing = await client.activity.findFirst({
        where: { type: input.type, refId: input.refId },
        select: { id: true },
      });
      if (existing) {
        // Idempotent no-op update, matching the old upsert's `update: {}`.
        await client.activity.update({ where: { id: existing.id }, data: {} });
      } else {
        await client.activity.create({ data });
      }
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
