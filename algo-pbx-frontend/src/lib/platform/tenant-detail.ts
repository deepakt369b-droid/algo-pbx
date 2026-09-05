import { unsafeGlobalDb as db } from "@/lib/db";
import { evaluateBillingAccess, type UiAccessState } from "@/lib/billing/enforcement";
import { evaluateCompliance, type ComplianceResult } from "./compliance";
import {
  subnetCidr,
  certCn,
  telephonyNamespace,
  gatewayTunnelIp,
  tunnelServerIp,
  dialplanContexts,
  isLegacyPooledTenant,
} from "./subnet";
import { workspaceHost, workspaceUrl, isLegacyCustomDomainTenant } from "./domain-constants";
import {
  emptyProvisioningState,
  nextStep,
  isComplete,
  progress,
  type ProvisioningState,
} from "./provisioning-machine";

// Everything the tenant detail page renders, assembled once on the server.
//
// The "identity & pooled-stack allocation" block is the reason this file
// exists in the shape it does: those values are MECHANICAL CONSEQUENCES of
// one integer (tunnelSubnetIndex) and one string (slug), and they are
// scattered across OpenVPN config files, cert CNs and Asterisk identities on
// the host. Deriving them here, from the same pure functions provisioning
// uses, means support reads the console instead of grepping config — and,
// more importantly, that what the console shows cannot drift from what
// provisioning actually created.

export interface TenantIdentity {
  workspaceHost: string;
  workspaceUrl: string;
  usesCustomDomain: boolean;
  subnetIndex: number | null;
  subnetCidr: string | null;
  tunnelServerIp: string | null;
  gatewayTunnelIp: string | null;
  certCn: string | null;
  telephonyNamespace: string | null;
  dialplanContexts: { fromAgent: string; fromDinstar: string } | null;
  isLegacyPooled: boolean;
}

export function deriveIdentity(slug: string, subnetIndex: number | null): TenantIdentity {
  const n = subnetIndex;
  return {
    workspaceHost: workspaceHost(slug),
    workspaceUrl: workspaceUrl(slug),
    usesCustomDomain: isLegacyCustomDomainTenant(slug),
    subnetIndex: n,
    // Everything below needs the allocated index. A tenant created before
    // allocation (or mid-provisioning) genuinely has no subnet yet, and the
    // UI must say "not allocated" rather than render a plausible-looking
    // 10.8.null.0/24 that matches nothing on the host.
    subnetCidr: n === null ? null : subnetCidr(n),
    tunnelServerIp: n === null ? null : tunnelServerIp(n),
    gatewayTunnelIp: n === null ? null : gatewayTunnelIp(n),
    certCn: certCn(slug),
    telephonyNamespace: n === null ? null : telephonyNamespace(n),
    dialplanContexts: n === null ? null : dialplanContexts(n),
    isLegacyPooled: isLegacyPooledTenant(slug, n),
  };
}

export function parseProvisioningState(raw: unknown): ProvisioningState {
  if (raw && typeof raw === "object" && Array.isArray((raw as ProvisioningState).completed)) {
    return {
      completed: (raw as ProvisioningState).completed.filter((s) => typeof s === "string"),
      lastError: (raw as ProvisioningState).lastError ?? null,
    };
  }
  return emptyProvisioningState();
}

export type TenantDetail = NonNullable<Awaited<ReturnType<typeof loadTenantDetail>>>;

export async function loadTenantDetail(tenantId: string, now: Date = new Date()) {
  const tenant = await db.tenant.findUnique({
    where: { id: tenantId },
    include: {
      gatewaySites: {
        orderBy: { createdAt: "asc" },
        include: {
          events: { orderBy: { receivedAt: "desc" }, take: 5 },
        },
      },
      recordingStorageTarget: true,
      supportGrants: {
        orderBy: { grantedAt: "desc" },
        take: 50,
        include: { platformUser: { select: { name: true, email: true } } },
      },
    },
  });
  if (!tenant) return null;

  const [userCount, extensionCount, deliveryCounts] = await Promise.all([
    // The N in "this suspends login for all N users". Excludes the disabled
    // platform-support system actor row that support-grant.ts creates, which
    // is not a person and would inflate the blast-radius wording.
    db.user.count({ where: { tenantId, disabled: false } }),
    db.extension.count({ where: { tenantId } }),
    db.recordingDelivery.groupBy({ by: ["state"], where: { tenantId }, _count: { _all: true } }),
  ]);

  const deliveries = { PENDING: 0, IN_FLIGHT: 0, DELIVERED: 0, FAILED: 0 } as Record<string, number>;
  for (const row of deliveryCounts) deliveries[row.state] = row._count._all;

  const provisioning = parseProvisioningState(tenant.provisioningState);

  return {
    tenant,
    identity: deriveIdentity(tenant.slug, tenant.tunnelSubnetIndex),
    billing: evaluateBillingAccess(tenant, now) as UiAccessState,
    compliance: evaluateCompliance(tenant) as ComplianceResult,
    provisioning: {
      state: provisioning,
      nextStep: nextStep(provisioning),
      complete: isComplete(provisioning),
      progress: progress(provisioning),
      // A tenant with an empty state predates the pipeline (tenant #1) rather
      // than being stuck at step one — the UI must not offer to "resume" a
      // provisioning run that never started.
      started: provisioning.completed.length > 0,
    },
    counts: { users: userCount, extensions: extensionCount },
    deliveries,
    lastDeliveryAt: null as Date | null,
  };
}
