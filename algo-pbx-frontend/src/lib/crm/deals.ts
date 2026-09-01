import { z } from "zod";
import { db } from "@/lib/db";
import { recordActivity } from "@/lib/crm/activity";
import { primaryContactId } from "@/lib/crm/pipeline-data";

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
  ownerId: z.string().optional(),
  expectedCloseAt: z.coerce.date().nullable().optional(),
});

export async function createDeal(
  data: z.infer<typeof DealCreateSchema>,
  fallbackOwnerId: string,
) {
  const firstStage =
    data.stageId ??
    (await db.pipelineStage.findFirst({ orderBy: { sortOrder: "asc" } }))?.id;
  if (!firstStage) throw new Error("No pipeline stages configured");

  const deal = await db.deal.create({
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
    },
    include: { stage: true },
  });

  await recordActivity({
    type: "DEAL_STAGE_CHANGE",
    summary: `Deal created in ${deal.stage.name}`,
    refId: `${deal.id}:${deal.stageId}`,
    dealId: deal.id,
    contactId: data.contactId ?? null,
    actorId: fallbackOwnerId,
  });

  return deal;
}

// Applies a patch and, when the stage actually changes, writes the unified
// timeline row (S2b spec). `actorId` is the signed-in user making the move.
export async function patchDeal(
  dealId: string,
  data: z.infer<typeof DealPatchSchema>,
  actorId: string,
) {
  const before = await db.deal.findUnique({ where: { id: dealId } });
  if (!before) return null;

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
    await recordActivity({
      type: "DEAL_STAGE_CHANGE",
      summary: `Moved to ${deal.stage.name}`,
      refId: `${dealId}:${data.stageId}`,
      dealId,
      contactId,
      actorId,
    });
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
