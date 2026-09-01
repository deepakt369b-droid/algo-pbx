"use client";

import { useEffect, useState } from "react";

interface WhatsAppSelf {
  assigned: boolean;
  label?: string;
  simPort?: number;
  phoneE164?: string | null;
  status?: "PAIRING" | "CONNECTED" | "DISCONNECTED" | "LOGGED_OUT";
  pushName?: string | null;
  lastError?: string | null;
}

const STATUS_COLOR: Record<string, string> = {
  CONNECTED: "bg-success",
  PAIRING: "bg-cyan animate-pulse",
  DISCONNECTED: "bg-danger",
  LOGGED_OUT: "bg-surface-hover",
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
    return <p className="px-1 text-xs text-tertiary">WhatsApp status unavailable.</p>;
  }
  if (!data) return null;

  if (!data.assigned) {
    return <p className="px-1 text-xs text-tertiary">No WhatsApp number assigned to you.</p>;
  }

  return (
    <div className="px-1">
      <div className="flex items-center gap-2 text-xs text-secondary">
        <span className={`h-1.5 w-1.5 rounded-full ${STATUS_COLOR[data.status ?? ""] ?? "bg-surface-hover"}`} />
        <span>
          {data.phoneE164 ?? `SIM ${data.simPort}`} — {data.status?.toLowerCase()}
        </span>
      </div>
      {data.lastError && (
        <p className="mt-1 rounded border border-danger/40 bg-danger-subtle px-2 py-1 text-[11px] leading-snug text-danger">
          {data.lastError}
        </p>
      )}
    </div>
  );
}
