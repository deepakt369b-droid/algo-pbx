"use client";

import { useEffect, useState } from "react";

interface WhatsAppSelf {
  assigned: boolean;
  label?: string;
  simPort?: number;
  phoneE164?: string | null;
  status?: "PAIRING" | "CONNECTED" | "DISCONNECTED" | "LOGGED_OUT";
  pushName?: string | null;
}

const STATUS_COLOR: Record<string, string> = {
  CONNECTED: "bg-green-400",
  PAIRING: "bg-cyan animate-pulse",
  DISCONNECTED: "bg-red-400",
  LOGGED_OUT: "bg-slate-500",
};

// Read-only connection badge for the agent's own chat panel — no control
// of any kind (pairing/logout stay exclusively in /admin/whatsapp). This
// is the piece three separate comments elsewhere in the codebase claimed
// already existed and none of them did.
export function WhatsAppConnectionBadge() {
  const [data, setData] = useState<WhatsAppSelf | null>(null);
  // A single fetch on mount went permanently stale — an admin pairing or
  // logging out an instance later was never reflected here. Poll every
  // 30s; on repeated failures show an explicit unavailable state instead
  // of silently rendering nothing.
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let consecutiveFailures = 0;
    const load = () => {
      fetch("/api/me/whatsapp", { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d) => {
          if (!cancelled) {
            setData(d);
            setFailed(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            consecutiveFailures += 1;
            if (consecutiveFailures >= 3) setFailed(true);
          }
        });
    };
    load();
    const interval = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (failed && !data) {
    return <p className="px-1 text-xs text-slate-600">WhatsApp status unavailable.</p>;
  }
  if (!data) return null;

  if (!data.assigned) {
    return <p className="px-1 text-xs text-slate-600">No WhatsApp number assigned to you.</p>;
  }

  return (
    <div className="flex items-center gap-2 px-1 text-xs text-slate-400">
      <span className={`h-1.5 w-1.5 rounded-full ${STATUS_COLOR[data.status ?? ""] ?? "bg-slate-500"}`} />
      <span>
        {data.phoneE164 ?? `SIM ${data.simPort}`} — {data.status?.toLowerCase()}
      </span>
    </div>
  );
}
