"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/client/api";

interface ActiveAlert {
  id: string;
  eventType: string | null;
  message: string;
  port: number | null;
  receivedAt: string;
}

const POLL_MS = 15000;

// Deliberately its OWN component, NOT a reuse of admin-shell/health-pill.tsx.
// That pill reads /api/admin/system/health, whose `dinstar` check is
// currently pinned "fail" by an unrelated, pre-existing gap (stale
// DINSTAR_SMS_USERNAME/PASSWORD `change-me` placeholder — see
// handoff.md), and overallStatus() returns "fail" if ANY check fails. A
// real gateway alert routed through that already-red indicator would be
// invisible on day one. This banner is a second, independent signal —
// fixing the SMS credential check is a separate, unrelated task.
export function GatewayAlertBanner() {
  const [active, setActive] = useState<ActiveAlert[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const data = await apiFetch<{ active: ActiveAlert[] }>("/api/admin/gateway-alerts");
        if (!cancelled) setActive(data.active);
      } catch {
        // Silent on failure — this is a supplementary banner, not the
        // primary health surface; a fetch failure here shouldn't itself
        // read as a gateway alert.
      }
    };
    load();
    const interval = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  if (active.length === 0) return null;

  return (
    <div className="w-full max-w-2xl rounded-lg border border-danger/40 bg-danger-subtle p-3 text-xs text-danger">
      <p className="mb-1 font-semibold">Gateway alert{active.length > 1 ? "s" : ""}</p>
      <ul className="flex flex-col gap-1">
        {active.map((a) => (
          <li key={a.id}>
            <span className="font-mono">{a.eventType}</span>
            {a.port !== null && <span> (port {a.port})</span>} — {a.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
