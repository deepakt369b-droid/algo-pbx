import { unsafeGlobalDb } from "@/lib/db";
import type { TenantClient } from "@/lib/db-tenant";

// Wave 2a multi-tenant migration: both exports now take a REQUIRED
// tenant-scoped `db: TenantClient` (src/lib/db-tenant.ts) instead of
// importing a module-level singleton — dependency injection per plan §2.
// Callers are the route handlers, which already have this client from
// requireSession()/requireStaffSession() (src/lib/auth-guard.ts).
//
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

export async function loadPipeline(db: TenantClient, ownerScope: string | null): Promise<{
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
//
// Deliberately does NOT take a `db: TenantClient` the way loadPipeline()
// does: DealContact is not on TENANT_SCOPED_MODELS
// (src/lib/tenancy/scope-rules.ts — it's a bare join table with no
// `tenantId` column of its own, riding on Deal's/Contact's own tenant
// scoping via FK), so a TOP-LEVEL call through a `TenantClient` would throw
// at runtime (unrecognized-model rejection, by design — "fail loudly rather
// than leak silently"). The caller (crm/deals.ts's patchDeal()) already
// proved `dealId` belongs to its tenant via an earlier tenant-scoped
// `db.deal.findUnique`, so a direct `unsafeGlobalDb` read here is safe:
// there is no tenant boundary on DealContact itself to cross.
export async function primaryContactId(dealId: string): Promise<string | null> {
  const links = await unsafeGlobalDb.dealContact.findMany({ where: { dealId } });
  return links.find((l) => l.isPrimary)?.contactId ?? links[0]?.contactId ?? null;
}
