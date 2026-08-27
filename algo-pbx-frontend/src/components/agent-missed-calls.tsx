"use client";

import { useCallback, useEffect, useState } from "react";
import { useSIP } from "@/contexts/sip-context";

interface MissedCall {
  id: string;
  callerNumber: string;
  startedAt: string;
  disposition: string;
}

// Derived entirely from CallDetailRecord via GET /api/me/missed-calls — no
// new call-log table exists or is needed. Same polling pattern as
// AgentVoicemail/AgentRecordings (this codebase has no websocket/SSE
// transport). Marks the list "seen" (clearing the unread badge in
// AgentShell) as soon as it's rendered with at least one call, matching
// how /admin/sign-ins treats "viewed the page" as "seen".
export function AgentMissedCalls() {
  const { makeCall } = useSIP();
  const [calls, setCalls] = useState<MissedCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/me/missed-calls", { cache: "no-store" });
      if (!res.ok) throw new Error(`Load failed (${res.status})`);
      const data = await res.json();
      setCalls(data.calls ?? []);
    } catch {
      setError("Could not load missed calls.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 20000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    if (calls.length > 0) {
      fetch("/api/me/missed-calls", { method: "POST" }).catch(() => undefined);
    }
  }, [calls.length]);

  if (loading && calls.length === 0 && !error) return null;
  if (error && calls.length === 0) {
    return (
      <div className="glass-card w-full max-w-2xl p-6">
        <p className="text-xs text-red-400">{error}</p>
      </div>
    );
  }
  if (calls.length === 0) return null;

  return (
    <div className="glass-card w-full max-w-2xl p-6">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Missed Calls</h2>
      {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
      <ul className="flex flex-col gap-3 text-sm text-slate-200">
        {calls.map((c) => (
          <li key={c.id} className="flex items-center justify-between gap-3 border-t border-border pt-3 first:border-0 first:pt-0">
            <div>
              <p>{c.callerNumber}</p>
              <p className="text-xs text-slate-500">
                {new Date(c.startedAt).toLocaleString()} · {c.disposition}
              </p>
            </div>
            <button
              onClick={() => makeCall(c.callerNumber)}
              className="rounded-lg border border-border px-3 py-1 text-xs text-cyan hover:border-cyan"
            >
              Call back
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
