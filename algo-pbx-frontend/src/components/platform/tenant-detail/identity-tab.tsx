"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { DependencyNotice } from "@/components/platform-shell/dependency-notice";
import { ConfirmActionDialog } from "@/components/platform-shell/confirm-action-dialog";
import { ComplianceChecklist } from "./compliance-checklist";
import { type SerialisedTenantDetail, type PlatformRole, fmtDate } from "./types";

// Identity & pooled-stack allocation.
//
// Most of this tab stays read-only, by design: every pooled-stack value here
// is a mechanical consequence of the tenant's slug and its tunnelSubnetIndex,
// both allocated once at provisioning and immutable afterwards. They are
// displayed because they otherwise live scattered across OpenVPN config
// files, certificate CNs and Asterisk identities on the host, and support
// should not have to SSH in and grep to answer "what is this customer's
// subnet".
//
// They are derived here from the same pure functions provisioning uses
// (src/lib/platform/subnet.ts), never re-typed as literals — so what this
// page claims and what provisioning actually created cannot drift apart.
//
// `name` and `complianceNotes`, however, are genuinely editable data (plan
// §1: "no PATCH/PUT /api/platform/tenants/[id] exists ... editable nowhere")
// — this tab is where that edit affordance lives, posting to the new
// `PATCH /api/platform/tenants/[id]`. Deliberately NOT `slug` or
// `tunnelSubnetIndex`: both are immutable for reasons stated on the route
// itself, and the route rejects them outright if sent.

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
  const router = useRouter();
  const { tenant, identity } = detail;
  const isOwner = role === "PLATFORM_OWNER";

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(tenant.name);
  const [complianceNotes, setComplianceNotes] = useState(tenant.complianceNotes ?? "");
  const [confirming, setConfirming] = useState(false);

  const dirty = name !== tenant.name || complianceNotes !== (tenant.complianceNotes ?? "");

  async function save(reason: string) {
    const res = await fetch(`/api/platform/tenants/${tenant.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, complianceNotes: complianceNotes || null, reason }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(err?.error ?? "Could not save. Nothing was changed.");
    }
    setEditing(false);
    router.refresh();
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardContent className="p-5">
          <div className="mb-1 flex items-baseline justify-between gap-2">
            <h2 className="text-[15px] font-semibold text-primary">Identity</h2>
            {isOwner && !editing && (
              <Button size="sm" variant="ghost" onClick={() => setEditing(true)} data-testid="action-edit-identity">
                Edit
              </Button>
            )}
          </div>
          <p className="mb-3 text-[12px] text-tertiary">
            Name is editable below. Everything else on this card is allocated at provisioning and
            immutable.
          </p>

          {editing ? (
            <div className="mb-4 space-y-3 rounded-[var(--radius)] border p-3 [border-color:rgb(var(--hairline))]">
              <div className="space-y-1.5">
                <Label htmlFor="tenant-name">Tenant name</Label>
                <Input
                  id="tenant-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  data-testid="tenant-name-input"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tenant-compliance-notes">Compliance notes</Label>
                <Textarea
                  id="tenant-compliance-notes"
                  rows={3}
                  value={complianceNotes}
                  onChange={(e) => setComplianceNotes(e.target.value)}
                  data-testid="tenant-compliance-notes-input"
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setName(tenant.name);
                    setComplianceNotes(tenant.complianceNotes ?? "");
                    setEditing(false);
                  }}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={!dirty || !name.trim()}
                  onClick={() => setConfirming(true)}
                  data-testid="action-save-identity"
                >
                  Save changes
                </Button>
              </div>
            </div>
          ) : (
            <Row label="Tenant name" value={tenant.name} mono={false} />
          )}

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

      {confirming && (
        <ConfirmActionDialog
          open
          onClose={() => setConfirming(false)}
          title="Save identity changes"
          blastRadius={`Updates ${tenant.name}'s name and/or compliance notes. Nothing telephony-related, billing-related, or access-related changes.`}
          confirmLabel="Save"
          tone="default"
          onConfirm={save}
        />
      )}
    </div>
  );
}
