"use client";

import { useState } from "react";
import { apiFetch, ApiError } from "@/lib/client/api";
import type { GatewaySite } from "./site-table";

// Inline edit form for /admin/connectivity — replaces the earlier
// window.prompt()-based LAN-IP-only editor now that PATCH
// /api/admin/gateway-sites/[id] accepts transport, tunnelIp, priority, and
// enabled (W2 — connectivity plan §3.2). `name` stays non-editable here too
// (it's the OpenVPN cert CN — see the API route's own comment); this form
// is deliberately everything ELSE an operator tunes after creation.
const TRANSPORT_OPTIONS: GatewaySite["transport"][] = ["TAILSCALE", "OPENVPN", "HEADSCALE", "WIREGUARD"];

export function SiteEditForm({
  site,
  onSaved,
  onCancel,
}: {
  site: GatewaySite;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [gatewayLanIp, setGatewayLanIp] = useState(site.gatewayLanIp);
  const [tunnelIp, setTunnelIp] = useState(site.tunnelIp ?? "");
  const [transport, setTransport] = useState<GatewaySite["transport"]>(site.transport);
  const [priority, setPriority] = useState(site.priority);
  const [enabled, setEnabled] = useState(site.enabled);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await apiFetch(`/api/admin/gateway-sites/${site.id}`, {
        method: "PATCH",
        body: {
          gatewayLanIp: gatewayLanIp.trim(),
          tunnelIp: tunnelIp.trim() === "" ? null : tunnelIp.trim(),
          transport,
          priority,
          enabled,
        },
      });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not update the site.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="glass-card flex w-full flex-col gap-3 p-4">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-secondary">Edit &quot;{site.name}&quot;</h3>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-xs text-tertiary">
          Gateway LAN IP
          <input
            value={gatewayLanIp}
            onChange={(e) => setGatewayLanIp(e.target.value)}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-tertiary">
          Tunnel IP
          <input
            value={tunnelIp}
            onChange={(e) => setTunnelIp(e.target.value)}
            placeholder="10.8.x.10"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
          />
        </label>

        <label className="flex flex-col gap-1 text-xs text-tertiary">
          Transport
          <select
            value={transport}
            onChange={(e) => setTransport(e.target.value as GatewaySite["transport"])}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
          >
            {TRANSPORT_OPTIONS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1 text-xs text-tertiary">
          Priority (lower wins for failover)
          <input
            type="number"
            min={1}
            max={1000}
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value))}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
          />
        </label>
      </div>

      <label className="flex items-center gap-2 text-xs text-secondary">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-3.5 w-3.5 accent-cyan" />
        Enabled (a disabled site is never chosen as failover primary)
      </label>

      {error && <p className="text-xs text-danger">{error}</p>}

      <div className="flex gap-2">
        <button
          onClick={save}
          disabled={saving || !gatewayLanIp.trim()}
          className="rounded-lg bg-cyan px-3 py-1.5 text-xs font-medium text-accent-fg disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button onClick={onCancel} className="rounded-lg border border-border px-3 py-1.5 text-xs text-secondary hover:text-primary">
          Cancel
        </button>
      </div>
    </div>
  );
}
