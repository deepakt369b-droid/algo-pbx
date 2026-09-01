"use client";

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/client/api";
import { SimPortBoard, type WaInstance } from "@/components/whatsapp/sim-port-board";

const REFRESH_INTERVAL_MS = 5000;

// Admin-only WhatsApp provisioning (Workstream E), presented as a fixed
// 2x2 SIM PORT BOARD: four slots mirroring the Dinstar's physical GSM
// ports, all visible at once, each either vacant (inline start-pairing) or
// holding a live scan-ready pairing code / QR — so up to four numbers can
// be linked in one sitting. Pairing, re-pairing, and logout live EXCLUSIVELY
// here — agent/page.tsx's chat panel shows a read-only connection badge
// with no control of any kind, and the underlying API routes
// (src/app/api/admin/whatsapp/instances/**) are requireAdminSession-gated
// so even a forged request from an agent's own session is rejected, not
// just hidden by this page not rendering a button.
export default function WhatsAppAdminPage() {
  const [instances, setInstances] = useState<WaInstance[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

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

  const connectedCount = instances.filter((i) => i.status === "CONNECTED").length;

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <div className="text-center">
        <h1 className="text-xl font-semibold text-primary">WhatsApp SIM Ports</h1>
        <p className="mt-1 max-w-2xl text-xs text-tertiary">
          One WhatsApp number per Dinstar GSM port — all four slots below stay live at once, each with
          its own pairing code or QR. Pairing and logout are admin-only; agents see a read-only
          connection status in their own chat panel.
        </p>
        <p className="mt-1 text-xs text-secondary">
          {connectedCount}/4 connected · {instances.length}/4 ports in use
          {connectedCount === 4 && <span className="ml-2 text-success">all linked</span>}
        </p>
      </div>

      <SimPortBoard instances={instances} loadError={loadError} onChanged={load} />
    </div>
  );
}
