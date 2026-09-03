"use client";

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/client/api";

interface GatewayEvent {
  id: string;
  receivedAt: string;
  deviceTime: string | null;
  severity: "EMERG" | "ALERT" | "CRIT" | "ERROR" | "WARNING" | "NOTICE" | "INFO" | "DEBUG";
  category: "GSM" | "SIP" | "VPN" | "SYSTEM" | "RAW";
  eventType: string | null;
  port: number | null;
  message: string;
  raw: string;
}

const POLL_MS = 10000;
const CATEGORIES = ["GSM", "SIP", "VPN", "SYSTEM", "RAW"] as const;

const SEVERITY_DOT: Record<GatewayEvent["severity"], string> = {
  EMERG: "bg-danger",
  ALERT: "bg-danger",
  CRIT: "bg-danger",
  ERROR: "bg-danger",
  WARNING: "bg-warning",
  NOTICE: "bg-warning",
  INFO: "bg-success",
  DEBUG: "bg-surface-hover",
};

// The Dinstar gateway's own Diagnostic -> Syslog forwarding (Tools ->
// Remote Server is an unrelated feature). Mounted on /admin/system,
// linked from /admin/dinstar. See src/lib/dinstar/syslog-parse.ts's
// header for the standing caveat this panel inherits: the parser/
// classifier was built without a real captured sample and needs
// re-validation once real gateway traffic is confirmed arriving.
export function GatewayEventsPanel() {
  const [events, setEvents] = useState<GatewayEvent[]>([]);
  const [lastCritical, setLastCritical] = useState<GatewayEvent | null>(null);
  const [category, setCategory] = useState<(typeof CATEGORIES)[number] | "">("");
  const [showRaw, setShowRaw] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const params = new URLSearchParams({ limit: "50" });
        if (category) params.set("category", category);
        const data = await apiFetch<{ events: GatewayEvent[]; lastCritical: GatewayEvent | null }>(
          `/api/admin/gateway-events?${params}`
        );
        if (!cancelled) {
          setEvents(data.events);
          setLastCritical(data.lastCritical);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : "Could not load gateway events.");
      }
    };
    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [category]);

  return (
    <div className="glass-card flex w-full max-w-2xl flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-primary">Gateway events</h2>
        <div className="flex items-center gap-2">
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value as (typeof CATEGORIES)[number] | "")}
            className="rounded border border-border bg-background px-2 py-1 text-xs text-secondary outline-none focus:border-cyan"
          >
            <option value="">All categories</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <button
            onClick={() => setShowRaw((v) => !v)}
            className="rounded border border-border px-2 py-1 text-xs text-secondary hover:bg-surface-hover"
          >
            {showRaw ? "Structured" : "Raw"}
          </button>
        </div>
      </div>

      {lastCritical && (
        <p className="rounded border border-danger/30 bg-danger-subtle px-2 py-1 text-xs text-danger">
          Last error: {lastCritical.message} ({new Date(lastCritical.receivedAt).toLocaleString()})
        </p>
      )}

      {error && <p className="text-xs text-danger">{error}</p>}

      {events.length === 0 && !error && (
        <p className="text-xs text-tertiary">No gateway events recorded yet.</p>
      )}

      <div className="flex max-h-96 flex-col gap-1.5 overflow-y-auto">
        {events.map((e) => (
          <div key={e.id} className="flex items-start gap-2 rounded px-2 py-1 text-xs hover:bg-surface-hover">
            <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${SEVERITY_DOT[e.severity]}`} />
            <span className="w-32 shrink-0 text-tertiary">{new Date(e.receivedAt).toLocaleString()}</span>
            <span className="w-14 shrink-0 text-secondary">{e.category}</span>
            {e.port !== null && <span className="w-10 shrink-0 text-tertiary">p{e.port}</span>}
            <span className="text-primary">{showRaw ? e.raw : e.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
