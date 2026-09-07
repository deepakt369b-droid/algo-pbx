"use client";

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/client/api";
import { SiteTable, type GatewaySite } from "@/components/connectivity/site-table";
import { SiteEditForm } from "@/components/connectivity/site-edit-form";
import { AddSiteWizard } from "@/components/connectivity/add-site-wizard";
import { ConnectivityRunbook } from "@/components/connectivity/runbook";

const POLL_MS = 30000;

// /admin/connectivity — the OpenVPN-primary/Headscale-fallback/
// Tailscale-legacy gateway connectivity hub. Site table (live status, 30s
// poll — the connectivity-check cron itself runs every 60s, so a faster
// UI poll would just show the same row twice), an Add-site wizard, and an
// always-visible runbook (manual fallback for both transports, never
// hidden behind automation). The one thing on this page that DOES touch
// the live SIP trunk is the explicit, confirmed "Cut over now" button —
// run by an operator, never by the 30s poll above.
export default function ConnectivityPage() {
  const [sites, setSites] = useState<GatewaySite[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [failoverEnabled, setFailoverEnabled] = useState(false);
  const [failoverBusy, setFailoverBusy] = useState(false);
  const [failoverError, setFailoverError] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await apiFetch<{ sites: GatewaySite[]; failoverEnabled: boolean }>("/api/admin/gateway-sites");
      setSites(data.sites);
      setFailoverEnabled(data.failoverEnabled);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load sites.");
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
  }, []);

  const remove = async (site: GatewaySite) => {
    if (!confirm(`Remove site "${site.name}"? This does not revoke its OpenVPN certificate — do that separately if needed.`)) return;
    try {
      await apiFetch(`/api/admin/gateway-sites/${site.id}`, { method: "DELETE" });
      load();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not remove the site.");
    }
  };

  const toggleFailover = async () => {
    const next = !failoverEnabled;
    if (
      next &&
      !confirm(
        "Enable automatic failover for this tenant?\n\nThis will re-point the live SIP trunk without a human clicking anything, whenever the supervisor decides the primary site is down. Off by default for a reason."
      )
    ) {
      return;
    }
    setFailoverBusy(true);
    setFailoverError(null);
    try {
      const data = await apiFetch<{ tenant: { failoverEnabled: boolean } }>("/api/admin/gateway-sites/failover-toggle", {
        method: "PATCH",
        body: { enabled: next },
      });
      setFailoverEnabled(data.tenant.failoverEnabled);
    } catch (err) {
      setFailoverError(err instanceof ApiError ? err.message : "Could not update the failover setting.");
    } finally {
      setFailoverBusy(false);
    }
  };

  const editingSite = sites.find((s) => s.id === editingId) ?? null;

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-primary">Connectivity</h1>
      <p className="max-w-2xl text-center text-xs text-tertiary">
        Gateway sites, their VPN transport, and live tunnel status. OpenVPN is the primary link to each site,
        Headscale is the documented fallback, and Tailscale is kept as a legacy path until a site&apos;s cutover is
        confirmed end-to-end.
      </p>

      <div className="glass-card w-full max-w-4xl p-6">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">Automatic failover</h2>
            <p className="mt-1 max-w-xl text-xs text-tertiary">
              Automatic failover will re-point the live SIP trunk without a human clicking anything. Off by default.
            </p>
          </div>
          <button
            onClick={toggleFailover}
            disabled={failoverBusy}
            className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
              failoverEnabled ? "bg-warning/20 text-warning" : "bg-surface-hover text-secondary"
            }`}
          >
            {failoverBusy ? "…" : failoverEnabled ? "Enabled — click to disable" : "Disabled — click to enable"}
          </button>
        </div>
        {failoverError && <p className="text-xs text-danger">{failoverError}</p>}
      </div>

      <div className="glass-card w-full max-w-4xl p-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">Sites</h2>
          <button onClick={() => setShowWizard((v) => !v)} className="rounded-lg bg-cyan px-3 py-1.5 text-xs font-medium text-accent-fg">
            {showWizard ? "Hide" : "Add site"}
          </button>
        </div>
        {loadError && <p className="mb-3 text-xs text-danger">{loadError}</p>}
        <SiteTable sites={sites} onEdit={(site) => setEditingId(site.id)} onDelete={remove} />

        {editingSite && (
          <div className="mt-4">
            <SiteEditForm
              site={editingSite}
              onSaved={() => {
                setEditingId(null);
                load();
              }}
              onCancel={() => setEditingId(null)}
            />
          </div>
        )}
      </div>

      {showWizard && (
        <div className="w-full max-w-4xl">
          <AddSiteWizard onCreated={() => load()} />
        </div>
      )}

      <div className="w-full max-w-4xl">
        <ConnectivityRunbook siteName={sites[0]?.name ?? ""} />
      </div>
    </div>
  );
}
