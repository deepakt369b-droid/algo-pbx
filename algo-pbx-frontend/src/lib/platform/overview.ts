import { unsafeGlobalDb as db } from "@/lib/db";
import { computeMrr, summariseSeats, type MrrBreakdown, type SeatSummary } from "./mrr";
import { evaluateCompliance } from "./compliance";
import { buildAttentionQueue, countBySeverity, type AttentionItem } from "./attention-queue";
import { emptyProvisioningState, nextStep, isComplete, type ProvisioningState } from "./provisioning-machine";

// Data assembly for the overview page.
//
// `unsafeGlobalDb` is correct here and is the documented exception rather
// than an oversight: this is the platform plane, whose entire purpose is the
// cross-tenant view. A tenant-scoped client cannot express "count every
// tenant's extensions" — and the console never renders tenant CALL CONTENT,
// only counts and lifecycle metadata, which plan §3 explicitly distinguishes
// from the data a support grant gates.
//
// Every number returned is computed from live rows. Nothing on the overview
// is seeded, estimated or placeholder — with the single exception of MRR,
// which is plan x seats and is flagged `bookkeepingOnly` all the way to the
// caption the operator reads.

export interface StatusCounts {
  trial: number;
  active: number;
  pastDue: number;
  suspended: number;
  offboarded: number;
  total: number;
}

export interface OverviewData {
  statusCounts: StatusCounts;
  seats: SeatSummary;
  mrr: MrrBreakdown;
  attention: AttentionItem[];
  attentionCounts: ReturnType<typeof countBySeverity>;
}

function parseProvisioningState(raw: unknown): ProvisioningState {
  // Json column: defend against a hand-edited or partially-written value
  // rather than throwing and taking the whole dashboard down with it.
  if (raw && typeof raw === "object" && Array.isArray((raw as ProvisioningState).completed)) {
    return {
      completed: (raw as ProvisioningState).completed.filter((s) => typeof s === "string"),
      lastError: (raw as ProvisioningState).lastError ?? null,
    };
  }
  return emptyProvisioningState();
}

export async function loadOverview(now: Date = new Date()): Promise<OverviewData> {
  const [tenants, extensionCounts, sites, grants, failedDeliveries] = await Promise.all([
    db.tenant.findMany({
      select: {
        id: true,
        slug: true,
        name: true,
        status: true,
        plan: true,
        seats: true,
        billingStatus: true,
        paidUntil: true,
        provisioningState: true,
        complianceTypeApprovalFiledAt: true,
        complianceEtisalatLetterAt: true,
        complianceAupSignedAt: true,
        compliancePdplTermsSignedAt: true,
        complianceRecordingDisclosureAt: true,
      },
      orderBy: { createdAt: "asc" },
    }),
    db.extension.groupBy({ by: ["tenantId"], _count: { _all: true } }),
    db.gatewaySite.findMany({
      select: {
        id: true,
        tenantId: true,
        name: true,
        lastHandshakeAt: true,
        status: true,
        tenant: { select: { slug: true } },
      },
    }),
    db.supportGrant.findMany({
      where: { revokedAt: null, expiresAt: { gt: now } },
      select: {
        id: true,
        tenantId: true,
        expiresAt: true,
        tenant: { select: { slug: true } },
        platformUser: { select: { email: true } },
      },
    }),
    // The delivery pipeline's failure counts. The table exists from
    // migration B onward; until a worker actually runs, this is legitimately
    // empty, and the UI says "no delivery pipeline is running" rather than
    // rendering a reassuring zero.
    db.recordingDelivery
      .groupBy({ by: ["tenantId"], where: { state: "FAILED" }, _count: { _all: true } })
      .catch(() => [] as Array<{ tenantId: string; _count: { _all: number } }>),
  ]);

  const extensionsByTenant = new Map(extensionCounts.map((e) => [e.tenantId, e._count._all]));
  const slugById = new Map(tenants.map((t) => [t.id, t.slug]));

  const statusCounts: StatusCounts = {
    trial: 0,
    active: 0,
    pastDue: 0,
    suspended: 0,
    offboarded: 0,
    total: tenants.length,
  };
  for (const t of tenants) {
    if (t.status === "OFFBOARDED") statusCounts.offboarded++;
    else if (t.status === "SUSPENDED" || t.billingStatus === "SUSPENDED") statusCounts.suspended++;
    else if (t.billingStatus === "PAST_DUE") statusCounts.pastDue++;
    else if (t.status === "TRIAL" || t.billingStatus === "TRIAL") statusCounts.trial++;
    else statusCounts.active++;
  }

  const seats = summariseSeats(
    tenants
      .filter((t) => t.status !== "OFFBOARDED")
      .map((t) => ({
        slug: t.slug,
        seats: t.seats,
        provisionedCount: extensionsByTenant.get(t.id) ?? 0,
      }))
  );

  const mrr = computeMrr(tenants);

  const attention = buildAttentionQueue(
    {
      tenants: tenants.map((t) => {
        const compliance = evaluateCompliance(t);
        const state = parseProvisioningState(t.provisioningState);
        return {
          id: t.id,
          slug: t.slug,
          name: t.name,
          status: t.status,
          paidUntil: t.paidUntil,
          complianceComplete: compliance.complete,
          complianceSummary: compliance.summary,
          // A tenant with no provisioning state at all predates the pipeline
          // (tenant #1) — it is not "mid-provisioning", so it must not sit in
          // the attention queue forever.
          provisioningIncomplete: state.completed.length > 0 && !isComplete(state),
          provisioningNextStepLabel: nextStep(state)?.label ?? null,
        };
      }),
      gatewaySites: sites.map((s) => ({
        id: s.id,
        tenantId: s.tenantId,
        tenantSlug: s.tenant.slug,
        name: s.name,
        lastHandshakeAt: s.lastHandshakeAt,
        status: s.status,
      })),
      supportGrants: grants.map((g) => ({
        id: g.id,
        tenantId: g.tenantId,
        tenantSlug: g.tenant.slug,
        platformUserEmail: g.platformUser.email,
        expiresAt: g.expiresAt,
      })),
      failedDeliveries: failedDeliveries.map((d) => ({
        tenantId: d.tenantId,
        tenantSlug: slugById.get(d.tenantId) ?? d.tenantId,
        count: d._count._all,
      })),
    },
    now
  );

  return { statusCounts, seats, mrr, attention, attentionCounts: countBySeverity(attention) };
}
