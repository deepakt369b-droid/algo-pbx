"use client";

import { useEffect, useState } from "react";

interface WaInstance {
  id: string;
  label: string;
  simPort: number;
  phoneE164: string | null;
  provider: "OPENWA" | "META_CLOUD" | "DINSTAR_SMS";
  status: "PAIRING" | "CONNECTED" | "DISCONNECTED" | "LOGGED_OUT";
  lastConnectedAt: string | null;
  pairedByAdmin: { name: string; email: string } | null;
}

const STATUS_COLOR: Record<WaInstance["status"], string> = {
  CONNECTED: "text-green-400",
  PAIRING: "text-cyan",
  DISCONNECTED: "text-slate-500",
  LOGGED_OUT: "text-red-400",
};

// Admin-only WhatsApp provisioning (Workstream E). Pairing, re-pairing,
// and logout live EXCLUSIVELY here — agent/page.tsx's chat panel shows a
// read-only connection badge with no control of any kind, and the
// underlying API routes (src/app/api/admin/whatsapp/instances/**) are
// requireAdminSession-gated so even a forged request from an agent's own
// session is rejected, not just hidden by this page not rendering a button.
export default function WhatsAppAdminPage() {
  const [instances, setInstances] = useState<WaInstance[]>([]);
  const [label, setLabel] = useState("");
  const [simPort, setSimPort] = useState(1);
  const [qr, setQr] = useState<{ instanceId: string; qrCode: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = () => {
    fetch("/api/admin/whatsapp/instances")
      .then((r) => r.json())
      .then((data) => setInstances(data.instances ?? []));
  };

  useEffect(load, []);

  const usedPorts = new Set(instances.map((i) => i.simPort));

  const pair = async () => {
    setMessage(null);
    const res = await fetch("/api/admin/whatsapp/instances", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ label, simPort, provider: "OPENWA" }),
    });
    const data = await res.json();
    if (res.ok) {
      setLabel("");
      if (data.pairing?.qrCode) setQr({ instanceId: data.instance.id, qrCode: data.pairing.qrCode });
      load();
    } else {
      setMessage(`Failed: ${JSON.stringify(data.error ?? data)}`);
    }
  };

  const act = async (id: string, action: "refresh" | "logout" | "repair") => {
    const res = await fetch(`/api/admin/whatsapp/instances/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    const data = await res.json();
    if (action === "repair" && data.pairing?.qrCode) setQr({ instanceId: id, qrCode: data.pairing.qrCode });
    load();
  };

  const remove = async (id: string) => {
    await fetch(`/api/admin/whatsapp/instances/${id}`, { method: "DELETE" });
    load();
  };

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-slate-100">WhatsApp Instances</h1>
      <p className="max-w-2xl text-center text-xs text-slate-500">
        Up to 4 instances — one per Dinstar SIM port. Pairing and logout are admin-only; agents see a
        read-only connection status in their own chat panel and have no control over these sessions.
      </p>

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
          <button onClick={pair} className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-background">
            Start pairing
          </button>
          {message && <p className="text-xs text-slate-500">{message}</p>}
        </div>
      )}

      {qr && (
        <div className="glass-card flex w-full max-w-xs flex-col items-center gap-3 p-6">
          <p className="text-xs text-slate-400">Scan with WhatsApp on the paired SIM&apos;s phone</p>
          {/* qrCode is a data: URL or raw string from the provider — render
              as an <img> when it looks like a data URL, else show the raw
              payload for manual QR generation as a fallback. */}
          {qr.qrCode.startsWith("data:") ? (
            <img src={qr.qrCode} alt="WhatsApp pairing QR code" className="h-48 w-48" />
          ) : (
            <p className="break-all text-xs text-slate-500">{qr.qrCode}</p>
          )}
          <button onClick={() => setQr(null)} className="text-xs text-slate-400 hover:text-slate-200">
            Dismiss
          </button>
        </div>
      )}

      <div className="glass-card w-full max-w-2xl p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
          Instances ({instances.length}/4)
        </h2>
        {instances.length === 0 ? (
          <p className="text-slate-500">None paired yet.</p>
        ) : (
          <ul className="flex flex-col gap-3 text-sm text-slate-200">
            {instances.map((i) => (
              <li key={i.id} className="flex items-center justify-between border-t border-border pt-3 first:border-0 first:pt-0">
                <div>
                  <p>
                    {i.label} <span className="text-xs text-slate-500">(SIM {i.simPort})</span>
                  </p>
                  <p className="text-xs text-slate-500">{i.phoneE164 ?? "not yet linked"}</p>
                  <p className={`text-xs font-medium ${STATUS_COLOR[i.status]}`}>{i.status}</p>
                </div>
                <div className="flex gap-2">
                  <button onClick={() => act(i.id, "refresh")} className="text-xs text-slate-400 hover:text-slate-200">
                    Refresh
                  </button>
                  {i.status !== "CONNECTED" && (
                    <button onClick={() => act(i.id, "repair")} className="text-xs text-cyan hover:underline">
                      Re-pair
                    </button>
                  )}
                  {i.status === "CONNECTED" && (
                    <button onClick={() => act(i.id, "logout")} className="text-xs text-red-400 hover:text-red-300">
                      Log out
                    </button>
                  )}
                  <button onClick={() => remove(i.id)} className="text-xs text-red-400 hover:text-red-300">
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
