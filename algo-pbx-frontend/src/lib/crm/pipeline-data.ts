import { db } from "@/lib/db";

// Shared by GET /api/admin/crm/pipeline and GET /api/agent/crm/pipeline —
// one query shape, two scopes. Agents (scope = their userId) see only their
// own deals; staff (scope = null) see every deal. Decimal `value` is
// serialised to a number here so the JSON payload is plain.
export type PipelineStageDto = {
  id: string;
  name: string;
  sortOrder: number;
  isWon: boolean;
  isLost: boolean;
  color: string | null;
};
export type PipelineDealDto = {
  id: string;
  name: string;
  stageId: string;
  value: number;
  currency: string;
  ownerId: string;
  owner: { id: string; name: string | null } | null;
  companyId: string | null;
  company: { id: string; name: string } | null;
  primaryContact: { id: string; displayName: string | null; numberE164: string } | null;
  expectedCloseAt: string | null;
  updatedAt: string;
};

export async function loadPipeline(ownerScope: string | null): Promise<{
  stages: PipelineStageDto[];
  deals: PipelineDealDto[];
}> {
  const [stages, deals] = await Promise.all([
    db.pipelineStage.findMany({ orderBy: { sortOrder: "asc" } }),
    db.deal.findMany({
      where: ownerScope ? { ownerId: ownerScope } : {},
      orderBy: { updatedAt: "desc" },
      include: {
        owner: { select: { id: true, name: true } },
        company: { select: { id: true, name: true } },
        contacts: {
          include: { contact: { select: { id: true, displayName: true, numberE164: true } } },
        },
      },
    }),
  ]);

  return {
    stages: stages.map((s) => ({
      id: s.id,
      name: s.name,
      sortOrder: s.sortOrder,
      isWon: s.isWon,
      isLost: s.isLost,
      color: s.color,
    })),
    deals: deals.map((d) => {
      const primary =
        d.contacts.find((c) => c.isPrimary)?.contact ?? d.contacts[0]?.contact ?? null;
      return {
        id: d.id,
        name: d.name,
        stageId: d.stageId,
        value: Number(d.value),
        currency: d.currency,
        ownerId: d.ownerId,
        owner: d.owner,
        companyId: d.companyId,
        company: d.company,
        primaryContact: primary,
        expectedCloseAt: d.expectedCloseAt ? d.expectedCloseAt.toISOString() : null,
        updatedAt: d.updatedAt.toISOString(),
      };
    }),
  };
}

// The primary contact id for a deal (for hanging an Activity row off a
// stage move), or null when the deal has no contacts linked.
export async function primaryContactId(dealId: string): Promise<string | null> {
  const links = await db.dealContact.findMany({ where: { dealId } });
  return links.find((l) => l.isPrimary)?.contactId ?? links[0]?.contactId ?? null;
}
