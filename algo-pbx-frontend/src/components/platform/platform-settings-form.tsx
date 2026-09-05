"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ConfirmActionDialog } from "@/components/platform-shell/confirm-action-dialog";

// Editable half of platform settings, plus the per-tenant reachability probe.
//
// The per-tenant subnet toggle is the notable control here. It enables code
// that widens the OpenVPN server to a /16 and writes per-tenant ccd/iroute
// entries — a change to a live tunnel configuration that has never completed
// a handshake. The approved plan says to finish G2 on the current single /24
// first, so the flag ships OFF and turning it on carries a confirmation that
// restates exactly that.

export function PlatformSettingsForm({
  isOwner,
  cloudflareConfigured,
  publicDomain,
  perTenantSubnetEnabled,
  tenants,
}: {
  isOwner: boolean;
  cloudflareConfigured: boolean;
  publicDomain: string;
  perTenantSubnetEnabled: boolean;
  tenants: Array<{ id: string; slug: string }>;
}) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [domain, setDomain] = useState(publicDomain);
  const [pending, setPending] = useState<null | { key: string; value: string; title: string; blast: string }>(null);
  const [probe, setProbe] = useState<Record<string, { ok: boolean; detail: string }>>({});
  const [probing, setProbing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save(reason: string) {
    if (!pending) return;
    const res = await fetch("/api/platform/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: pending.key, value: pending.value, reason }),
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(json?.error ?? "Could not save the setting.");
    }
    setToken("");
    router.refresh();
  }

  async function runProbe(tenantId: string) {
    setProbing(tenantId);
    setError(null);
    try {
      const res = await fetch(`/api/platform/tenants/${tenantId}/reachability`);
      const json = (await res.json().catch(() => null)) as { ok?: boolean; detail?: string } | null;
      setProbe((p) => ({
        ...p,
        [tenantId]: { ok: Boolean(json?.ok), detail: json?.detail ?? "No response." },
      }));
    } catch (err) {
      setProbe((p) => ({
        ...p,
        [tenantId]: { ok: false, detail: err instanceof Error ? err.message : "Probe failed." },
      }));
    } finally {
      setProbing(null);
    }
  }

  if (!isOwner) {
    return (
      <p className="text-[12px] text-tertiary">
        Only a platform owner can change these settings. The per-tenant reachability probe is
        available to owners.
      </p>
    );
  }

  return (
    <div className="space-y-5 border-t pt-4 [border-color:rgb(var(--hairline))]">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="cf-token">Cloudflare API token</Label>
          <Input
            id="cf-token"
            type="password"
            value={token}
            placeholder={cloudflareConfigured ? "Configured — enter a new token to replace" : "Not configured"}
            onChange={(e) => setToken(e.target.value)}
            autoComplete="off"
            data-testid="cf-token-input"
          />
          <p className="text-[11px] text-tertiary">
            Verified against Cloudflare before it is stored, so an invalid token fails here rather
            than at certificate renewal. Never displayed again after saving.
          </p>
          <Button
            size="sm"
            variant="secondary"
            disabled={!token}
            onClick={() =>
              setPending({
                key: "CLOUDFLARE_API_TOKEN",
                value: token,
                title: "Replace Cloudflare API token",
                blast:
                  "This token can rewrite DNS for every tenant workspace and is used for certificate renewal. An invalid or over-scoped token affects all tenants at once.",
              })
            }
          >
            Save token
          </Button>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="public-domain">Public domain</Label>
          <Input
            id="public-domain"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            data-testid="public-domain-input"
          />
          <p className="text-[11px] text-tertiary">
            The host this platform presents itself as. Changing it does not reconfigure running
            containers on its own.
          </p>
          <Button
            size="sm"
            variant="secondary"
            disabled={!domain || domain === publicDomain}
            onClick={() =>
              setPending({
                key: "VM_PUBLIC_DOMAIN",
                value: domain,
                title: "Change public domain",
                blast:
                  "Every tenant's agents connect through this host. Changing it without also reissuing certificates and updating DNS will break WebRTC signalling for all of them.",
              })
            }
          >
            Save domain
          </Button>
        </div>
      </div>

      {/* --- The gated /16 widening ------------------------------------- */}
      <div className="rounded-[var(--radius)] border p-3 [border-color:rgb(var(--hairline))]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[13px] font-medium text-primary">
              Per-tenant subnets{" "}
              <Badge tone={perTenantSubnetEnabled ? "success" : "neutral"}>
                {perTenantSubnetEnabled ? "Enabled" : "Disabled"}
              </Badge>
            </p>
            <p className="text-[12px] text-secondary">
              Widens the OpenVPN server to 10.8.0.0/16 and lets provisioning write per-tenant
              ccd/iroute entries and firewall rules. Off by default: the deployed server is a single
              10.8.0.0/24 that has never completed a handshake, and the approved plan is to finish
              G2 on it before widening.
            </p>
          </div>
          <Button
            size="sm"
            variant={perTenantSubnetEnabled ? "secondary" : "danger"}
            data-testid="toggle-per-tenant-subnet"
            onClick={() =>
              setPending({
                key: "PROVISIONING_PER_TENANT_SUBNET_ENABLED",
                value: perTenantSubnetEnabled ? "false" : "true",
                title: perTenantSubnetEnabled ? "Disable per-tenant subnets" : "Enable per-tenant subnets",
                blast: perTenantSubnetEnabled
                  ? "Provisioning will stop writing ccd and firewall entries. Existing entries are left alone."
                  : "This enables changes to a live tunnel configuration that has never completed a handshake. The approved plan says to finish G2 on the current single /24 first and not stack an untested subnet redesign on an unproven tunnel. Enable this only after G2 has passed, in a maintenance window.",
              })
            }
          >
            {perTenantSubnetEnabled ? "Disable" : "Enable"}
          </Button>
        </div>
      </div>

      {/* --- Per-tenant reachability ------------------------------------ */}
      <div>
        <p className="mb-2 text-[13px] font-medium text-primary">Per-tenant TLS &amp; reachability</p>
        <ul className="space-y-1.5" data-testid="tenant-probes">
          {tenants.map((t) => {
            const r = probe[t.id];
            return (
              <li
                key={t.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius)] border p-2.5 [border-color:rgb(var(--hairline))]"
              >
                <span className="font-mono text-[13px] text-primary">{t.slug}</span>
                <span className="flex items-center gap-2">
                  {r && (
                    <span className={`text-[12px] ${r.ok ? "text-success" : "text-danger"}`}>
                      {r.detail}
                    </span>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={probing === t.id}
                    onClick={() => runProbe(t.id)}
                  >
                    {probing === t.id ? "Probing…" : "Test"}
                  </Button>
                </span>
              </li>
            );
          })}
          {tenants.length === 0 && <li className="text-[12px] text-tertiary">No active tenants.</li>}
        </ul>
        <p className="mt-1.5 text-[11px] text-tertiary">
          Read-only. This checks DNS resolution and TLS; it never writes a DNS record.
        </p>
      </div>

      {error && (
        <p role="alert" className="text-[12px] text-danger">
          {error}
        </p>
      )}

      {pending && (
        <ConfirmActionDialog
          open
          onClose={() => setPending(null)}
          title={pending.title}
          blastRadius={pending.blast}
          confirmLabel="Save setting"
          tone="danger"
          onConfirm={save}
        />
      )}
    </div>
  );
}
