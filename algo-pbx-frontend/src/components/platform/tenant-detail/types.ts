// Serialised shape of loadTenantDetail()'s result as it crosses the
// server/client boundary.
//
// Dates arrive as ISO strings (the page JSON-serialises the payload), so this
// is deliberately NOT `TenantDetail` from the server module — typing it as
// the server shape would claim `Date` objects that are really strings, and
// every `.getTime()` in a tab would be a runtime error the compiler happily
// waved through.

export interface SerialisedTenantDetail {
  tenant: {
    id: string;
    slug: string;
    name: string;
    status: "TRIAL" | "ACTIVE" | "SUSPENDED" | "OFFBOARDED";
    plan: string;
    seats: number;
    billingStatus: "TRIAL" | "ACTIVE" | "PAST_DUE" | "SUSPENDED";
    paidUntil: string | null;
    billingRef: string | null;
    billingProvider: string | null;
    tunnelSubnetIndex: number | null;
    suspendedAt: string | null;
    offboardedAt: string | null;
    dialplanCutAt: string | null;
    complianceTypeApprovalFiledAt: string | null;
    complianceEtisalatLetterAt: string | null;
    complianceAupSignedAt: string | null;
    compliancePdplTermsSignedAt: string | null;
    complianceRecordingDisclosureAt: string | null;
    complianceNotes: string | null;
    createdAt: string;
    gatewaySites: Array<{
      id: string;
      name: string;
      gatewayLanIp: string;
      tunnelIp: string | null;
      transport: "TAILSCALE" | "OPENVPN" | "HEADSCALE";
      status: "UNKNOWN" | "UP" | "DEGRADED" | "DOWN";
      lastHandshakeAt: string | null;
      lastReachableAt: string | null;
      events: Array<{
        id: string;
        receivedAt: string;
        severity: string;
        category: string;
        message: string;
      }>;
    }>;
    recordingStorageTarget: {
      id: string;
      kind: "PLATFORM_LOCAL" | "CUSTOMER_S3" | "CUSTOMER_SFTP";
      enabled: boolean;
      verifyBeforePurge: boolean;
      lastVerifiedAt: string | null;
    } | null;
    supportGrants: Array<{
      id: string;
      reason: string;
      grantedAt: string;
      expiresAt: string;
      revokedAt: string | null;
      platformUser: { name: string; email: string };
    }>;
  };
  identity: {
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
  };
  billing: {
    rung: "ok" | "warning" | "login_blocked";
    graceDaysRemaining: number | null;
    ownerExempt: boolean;
    bannerText: string | null;
  };
  compliance: {
    complete: boolean;
    filedCount: number;
    totalCount: number;
    summary: string;
    items: Array<{ id: string; label: string; why: string; filedAt: string | null }>;
    missing: Array<{ id: string; label: string }>;
  };
  provisioning: {
    state: { completed: string[]; lastError?: { step: string; message: string } | null };
    nextStep: { id: string; label: string; description: string; gate: "auto" | "human" } | null;
    complete: boolean;
    progress: { completed: number; total: number };
    started: boolean;
  };
  counts: { users: number; extensions: number };
  deliveries: Record<string, number>;
}

export type PlatformRole = "PLATFORM_OWNER" | "PLATFORM_SUPPORT";

export function fmtDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

export function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
