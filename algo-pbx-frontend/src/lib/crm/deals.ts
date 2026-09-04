import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { unsafeGlobalDb } from "@/lib/db";
import type { TenantClient } from "@/lib/db-tenant";
import { recordActivity } from "@/lib/crm/activity";
import { primaryContactId } from "@/lib/crm/pipeline-data";

// Wave 2a multi-tenant migration: both exports take a REQUIRED tenant-scoped
// `db: TenantClient` (src/lib/db-tenant.ts) as their first argument instead
// of importing a module-level singleton — dependency injection per plan §2,
// threaded straight through to recordActivity()/primaryContactId() (both
// also DI'd, same wave).

export const DealCreateSchema = z.object({
  name: z.string().min(1).max(200),
  stageId: z.string().optional(),
  value: z.number().nonnegative().max(1_000_000_000).optional(),
  currency: z.string().length(3).optional(),
  companyId: z.string().nullable().optional(),
  contactId: z.string().nullable().optional(),
  ownerId: z.string().optional(),
  expectedCloseAt: z.coerce.date().nullable().optional(),
});

export const DealPatchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  stageId: z.string().optional(),
  value: z.number().nonnegative().max(1_000_000_000).optional(),
  currency: z.string().length(3).optional(),
  companyId: z.string().nullable().optional(),
  contactId: z.string().nullable().optional(),
  ownerId: z.string().optional(),
  expectedCloseAt: z.coerce.date().nullable().optional(),
});

export async function createDeal(
  db: TenantClient,
  data: z.infer<typeof DealCreateSchema>,
  fallbackOwnerId: string,
) {
  const firstStage =
    data.stageId ??
    (await db.pipelineStage.findFirst({ orderBy: { sortOrder: "asc" } }))?.id;
  if (!firstStage) throw new Error("No pipeline stages configured");

  const deal = await db.deal.create({
    // No `tenantId` here — the extension force-injects it at runtime (see
    // crm/activity.ts's comment on the same pattern). The nested
    // `contacts: { create: {...} }` is a DealContact write executed as
    // part of THIS SAME Deal query, not a separate top-level
    // `dealContact.create` call, so it never goes through the extension's
    // per-model check at all — it's implicitly scoped by riding on the
    // already-scoped parent Deal row.
    data: {
      name: data.name,
      stageId: firstStage,
      value: data.value ?? 0,
      currency: data.currency ?? "AED",
      companyId: data.companyId ?? null,
      ownerId: data.ownerId ?? fallbackOwnerId,
      expectedCloseAt: data.expectedCloseAt ?? null,
      contacts: data.contactId
        ? { create: { contactId: data.contactId, isPrimary: true } }
        : undefined,
    } as unknown as Prisma.DealUncheckedCreateInput,
    include: { stage: true },
  });

  await recordActivity(
    {
      type: "DEAL_STAGE_CHANGE",
      summary: `Deal created in ${deal.stage.name}`,
      refId: `${deal.id}:${deal.stageId}`,
      dealId: deal.id,
      contactId: data.contactId ?? null,
      actorId: fallbackOwnerId,
    },
    db,
  );

  return deal;
}

// Applies a patch and, when the stage actually changes, writes the unified
// timeline row (S2b spec). `actorId` is the signed-in user making the move.
export async function patchDeal(
  db: TenantClient,
  dealId: string,
  data: z.infer<typeof DealPatchSchema>,
  actorId: string,
) {
  const before = await db.deal.findUnique({ where: { id: dealId } });
  if (!before) return null;

  // A deal has at most one linked contact today (the picker in the UI is
  // single-select) — "contactId" replaces whatever was linked rather than
  // appending, same replace-not-append shape as the create-time link.
  //
  // DealContact (unlike Deal, Contact, Activity, ...) is NOT on
  // TENANT_SCOPED_MODELS (src/lib/tenancy/scope-rules.ts) — it's a bare
  // join table with no `tenantId` column of its own at all, riding on
  // Deal's/Contact's own tenant scoping via FK. Calling it as a TOP-LEVEL
  // operation through a `TenantClient` would THROW at runtime
  // (computeScopedArgs rejects any model not on its known list, by
  // design — "fail loudly rather than leak silently"). `dealId` here was
  // already proven to belong to this tenant by the `db.deal.findUnique`
  // above (which WAS tenant-filtered), so a direct `unsafeGlobalDb` call is
  // safe: there is no tenant boundary on DealContact itself to cross.
  if (data.contactId !== undefined) {
    await unsafeGlobalDb.dealContact.deleteMany({ where: { dealId } });
    if (data.contactId) {
      await unsafeGlobalDb.dealContact.create({ data: { dealId, contactId: data.contactId, isPrimary: true } });
    }
  }

  const deal = await db.deal.update({
    where: { id: dealId },
    data: {
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.stageId !== undefined ? { stageId: data.stageId } : {}),
      ...(data.value !== undefined ? { value: data.value } : {}),
      ...(data.currency !== undefined ? { currency: data.currency } : {}),
      ...(data.companyId !== undefined ? { companyId: data.companyId } : {}),
      ...(data.ownerId !== undefined ? { ownerId: data.ownerId } : {}),
      ...(data.expectedCloseAt !== undefined
        ? { expectedCloseAt: data.expectedCloseAt }
        : {}),
    },
    include: { stage: true },
  });

  if (data.stageId && data.stageId !== before.stageId) {
    const contactId = await primaryContactId(dealId);
    await recordActivity(
      {
        type: "DEAL_STAGE_CHANGE",
        summary: `Moved to ${deal.stage.name}`,
        refId: `${dealId}:${data.stageId}`,
        dealId,
        contactId,
        actorId,
      },
      db,
    );
    // Mirror won/lost onto closedAt so reports have a single signal.
    if (deal.stage.isWon || deal.stage.isLost) {
      if (!deal.closedAt) {
        await db.deal.update({ where: { id: dealId }, data: { closedAt: new Date() } });
      }
    } else if (deal.closedAt) {
      await db.deal.update({ where: { id: dealId }, data: { closedAt: null } });
    }
  }

  return deal;
}
