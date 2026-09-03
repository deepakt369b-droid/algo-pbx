"use client";

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/client/api";
import { SiteTable, type GatewaySite } from "@/components/connectivity/site-table";
import { AddSiteWizard } from "@/components/connectivity/add-site-wizard";
import { ConnectivityRunbook } from "@/components/connectivity/runbook";

const POLL_MS = 30000;

// /admin/connectivity — the OpenVPN-primary/Headscale-fallback/
// Tailscale-legacy gateway connectivity hub. Site table (live status, 30s
// poll — the connectivity-check cron itself runs every 60s, so a faster
// UI poll would just show the same row twice), an Add-site wizard, and an
// always-visible runbook (manual fallback for both transports, never
// hidden behind automation). Nothing on this page touches the live SIP
// trunk — that only happens via the explicit, separate cutover action a
// later build phase adds, run by an operator, not automatically.
export default function ConnectivityPage() {
  const [sites, setSites] = useState<GatewaySite[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);

  const load = async () => {
    try {
      const data = await apiFetch<{ sites: GatewaySite[] }>("/api/admin/gateway-sites");
      setSites(data.sites);
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

  // Minimal, deliberately narrow: `name` isn't editable post-creation (see
  // the API route's own comment — it's the OpenVPN cert CN), so the only
  // thing worth a quick edit here is the LAN IP if the gateway's address
  // changes. A fuller edit form is unwarranted scope for a single field.
  const editLanIp = async (site: GatewaySite) => {
    const next = window.prompt(`Gateway LAN IP for "${site.name}"`, site.gatewayLanIp);
    if (next === null || next.trim() === "" || next === site.gatewayLanIp) return;
    try {
      await apiFetch(`/api/admin/gateway-sites/${site.id}`, { method: "PATCH", body: { gatewayLanIp: next.trim() } });
      load();
    } catch (err) {
      alert(err instanceof ApiError ? err.message : "Could not update the site.");
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-primary">Connectivity</h1>
      <p className="max-w-2xl text-center text-xs text-tertiary">
        Gateway sites, their VPN transport, and live tunnel status. OpenVPN is the primary link to each site,
        Headscale is the documented fallback, and Tailscale is kept as a legacy path until a site&apos;s cutover is
        confirmed end-to-end.
      </p>

      <div className="glass-card w-full max-w-4xl p-6">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">Sites</h2>
          <button onClick={() => setShowWizard((v) => !v)} className="rounded-lg bg-cyan px-3 py-1.5 text-xs font-medium text-accent-fg">
            {showWizard ? "Hide" : "Add site"}
          </button>
        </div>
        {loadError && <p className="mb-3 text-xs text-danger">{loadError}</p>}
        <SiteTable sites={sites} onEdit={editLanIp} onDelete={remove} />
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
