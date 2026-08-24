"use client";

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/client/api";
import { PairingCard, type WaInstance } from "@/components/whatsapp/pairing-card";

const REFRESH_INTERVAL_MS = 5000;

// Admin-only WhatsApp provisioning (Workstream E). Pairing, re-pairing,
// and logout live EXCLUSIVELY here — agent/page.tsx's chat panel shows a
// read-only connection badge with no control of any kind, and the
// underlying API routes (src/app/api/admin/whatsapp/instances/**) are
// requireAdminSession-gated so even a forged request from an agent's own
// session is rejected, not just hidden by this page not rendering a button.
//
// Each SIM port gets its OWN card with its own live QR/pairing-code state
// (src/components/whatsapp/pairing-card.tsx) — the previous version of
// this page kept a single global `qr` variable, so only one instance
// could ever show a code at a time.
export default function WhatsAppAdminPage() {
  const [instances, setInstances] = useState<WaInstance[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [simPort, setSimPort] = useState(1);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const load = async () => {
    try {
      const data = await apiFetch<{ instances: WaInstance[] }>("/api/admin/whatsapp/instances");
      setInstances(data.instances ?? []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load WhatsApp instances.");
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, []);

  const usedPorts = new Set(instances.map((i) => i.simPort));

  const pair = async () => {
    setCreating(true);
    setCreateError(null);
    try {
      await apiFetch("/api/admin/whatsapp/instances", {
        method: "POST",
        body: { label, simPort, provider: "OPENWA" },
      });
      setLabel("");
      await load();
    } catch (err) {
      setCreateError(err instanceof ApiError ? err.message : "Could not start pairing.");
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-slate-100">WhatsApp Instances</h1>
      <p className="max-w-2xl text-center text-xs text-slate-500">
        Up to 4 instances — one per Dinstar SIM port. Pairing and logout are admin-only; agents see a
        read-only connection status in their own chat panel and have no control over these sessions.
      </p>

      {loadError && (
        <div className="w-full max-w-2xl rounded-lg border border-red-900 bg-red-950/40 px-4 py-2 text-center text-xs text-red-300">
          {loadError}
        </div>
      )}

      {instances.length < 4 && (
        <div className="glass-card flex w-full max-w-md flex-col gap-3 p-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">Pair a new instance</h2>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label, e.g. SIM 1 — +971 5X XXX XXXX"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
          />
          <select
            value={simPort}
            onChange={(e) => setSimPort(Number(e.target.value))}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
          >
            {[1, 2, 3, 4].map((p) => (
              <option key={p} value={p} disabled={usedPorts.has(p)}>
                SIM port {p} {usedPorts.has(p) ? "(in use)" : ""}
              </option>
            ))}
          </select>
          <button
            onClick={pair}
            disabled={creating || !label.trim() || usedPorts.has(simPort)}
            className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
          >
            {creating ? "Starting…" : "Start pairing"}
          </button>
          {createError && <p className="text-xs text-red-400">{createError}</p>}
        </div>
      )}

      <div className="flex w-full max-w-2xl flex-col gap-4">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
          Instances ({instances.length}/4)
        </h2>
        {instances.length === 0 && !loadError ? (
          <div className="glass-card flex flex-col items-center gap-2 p-8 text-center">
            <p className="text-slate-300">No WhatsApp numbers paired yet.</p>
            <p className="text-xs text-slate-500">Pair a SIM port above to get started — each number gets its own live QR or pairing code.</p>
          </div>
        ) : (
          instances.map((instance) => <PairingCard key={instance.id} instance={instance} onChanged={load} />)
        )}
      </div>
    </div>
  );
}
