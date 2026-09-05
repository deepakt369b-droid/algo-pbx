"use client";

import { Card, CardContent } from "@/components/ui/card";
import { DependencyNotice } from "@/components/platform-shell/dependency-notice";
import { ComplianceChecklist } from "./compliance-checklist";
import { type SerialisedTenantDetail, type PlatformRole, fmtDate } from "./types";

// Identity & pooled-stack allocation — read-only, by design.
//
// Every value here is a mechanical consequence of the tenant's slug and its
// tunnelSubnetIndex, both allocated once at provisioning and immutable
// afterwards. They are displayed because they otherwise live scattered across
// OpenVPN config files, certificate CNs and Asterisk identities on the host,
// and support should not have to SSH in and grep to answer "what is this
// customer's subnet".
//
// They are derived here from the same pure functions provisioning uses
// (src/lib/platform/subnet.ts), never re-typed as literals — so what this
// page claims and what provisioning actually created cannot drift apart.

function Row({
  label,
  value,
  mono = true,
  hint,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b py-2 last:border-0 [border-color:rgb(var(--hairline))]">
      <span className="text-[12px] text-tertiary">{label}</span>
      <span className="text-right">
        <span
          className={`text-[13px] ${value ? "text-primary" : "text-tertiary"} ${mono && value ? "font-mono" : ""}`}
        >
          {value ?? "Not allocated"}
        </span>
        {hint && <span className="block text-[11px] text-tertiary">{hint}</span>}
      </span>
    </div>
  );
}

export function IdentityTab({
  detail,
  role,
}: {
  detail: SerialisedTenantDetail;
  role: PlatformRole;
}) {
  const { tenant, identity } = detail;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardContent className="p-5">
          <h2 className="mb-1 text-[15px] font-semibold text-primary">Identity</h2>
          <p className="mb-3 text-[12px] text-tertiary">
            Allocated at provisioning and immutable. Read-only everywhere.
          </p>
          <Row label="Slug" value={tenant.slug} />
          <Row
            label="Workspace URL"
            value={identity.workspaceHost}
            hint={identity.usesCustomDomain ? "Custom domain — tenant #1 exception" : undefined}
          />
          <Row label="Created" value={fmtDate(tenant.createdAt)} mono={false} />
          <Row label="Plan / seats" value={`${tenant.plan} · ${tenant.seats}`} mono={false} />
          <Row
            label="Extensions provisioned"
            value={`${detail.counts.extensions}`}
            mono={false}
            hint={
              detail.counts.extensions > tenant.seats
                ? "Over the allocated seat count"
                : undefined
            }
          />
          <Row label="Active users" value={`${detail.counts.users}`} mono={false} />
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5">
          <h2 className="mb-1 text-[15px] font-semibold text-primary">Pooled-stack allocation</h2>
          <p className="mb-3 text-[12px] text-tertiary">
            Derived from tunnel subnet index {identity.subnetIndex ?? "—"}. These are the exact
            identifiers on the host.
          </p>
          <Row label="Subnet" value={identity.subnetCidr} />
          <Row label="Tunnel server IP" value={identity.tunnelServerIp} />
          <Row label="Gateway tunnel IP" value={identity.gatewayTunnelIp} />
          <Row label="Certificate CN" value={identity.certCn} hint="= ccd filename = GatewaySite.name" />
          <Row label="Telephony namespace" value={identity.telephonyNamespace} />
          <Row
            label="Dialplan contexts"
            value={
              identity.dialplanContexts
                ? `${identity.dialplanContexts.fromAgent} · ${identity.dialplanContexts.fromDinstar}`
                : null
            }
          />

          {identity.isLegacyPooled && (
            <p className="mt-3 rounded-[var(--radius)] bg-surface-subtle p-2.5 text-[11px] text-tertiary">
              This tenant predates per-tenant subnets and shares the original 10.8.0.0/24.
            </p>
          )}

          {identity.telephonyNamespace && (
            <DependencyNotice
              className="mt-3"
              tone="info"
              feature="Telephony namespacing"
              blockedOn="Wave 6 — renaming PJSIP endpoints and dialplan contexts needs a live Asterisk and a maintenance window."
              evidence="The names above are what provisioning will create; Asterisk does not use them yet."
            />
          )}
        </CardContent>
      </Card>

      <div className="lg:col-span-2">
        <ComplianceChecklist detail={detail} role={role} />
      </div>
    </div>
  );
}
