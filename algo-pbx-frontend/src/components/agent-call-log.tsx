"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSIP } from "@/contexts/sip-context";

interface CallRow {
  id: string;
  callerNumber: string;
  destination: string;
  direction: string;
  disposition: string;
  startedAt: string;
  billsecSec: number;
  recordingUrl: string | null;
  callerDisplayName: string | null;
  callerContactId: string | null;
}

function formatDuration(seconds: number): string {
  if (seconds <= 0) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// This agent's own recent call history — GET /api/me/calls, own-extension
// scoped. Before this component existed there was NO call-log view
// anywhere in the agent UI (reported live 2026-08-29); /agent/missed shows
// only a narrower slice (unconnected inbound calls). Same polling pattern
// as AgentRecordings/AgentMissedCalls — this codebase has no
// websocket/SSE transport for CDR updates.
export function AgentCallLog() {
  const { makeCall } = useSIP();
  const [calls, setCalls] = useState<CallRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/me/calls", { cache: "no-store" });
      if (!res.ok) throw new Error(`Load failed (${res.status})`);
      const data = await res.json();
      setCalls(data.calls ?? []);
    } catch {
      setError("Could not load call history.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 20000);
    return () => clearInterval(interval);
  }, [load]);

  if (loading && calls.length === 0 && !error) return null;

  if (error && calls.length === 0) {
    return (
      <div className="glass-card w-full max-w-2xl p-6">
        <p className="text-xs text-red-400">{error}</p>
      </div>
    );
  }

  if (calls.length === 0) {
    return (
      <div className="glass-card w-full max-w-2xl p-6">
        <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-slate-400">Call History</h2>
        <p className="text-xs text-slate-500">No calls yet.</p>
      </div>
    );
  }

  return (
    <div className="glass-card w-full max-w-2xl p-6">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">Call History</h2>
      {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
      <ul className="flex flex-col gap-3 text-sm text-slate-200">
        {calls.map((c) => {
          const otherParty = c.direction === "outbound" ? c.destination : c.callerNumber;
          const displayName = c.direction === "outbound" ? null : c.callerDisplayName;
          return (
            <li
              key={c.id}
              className="flex items-center justify-between gap-3 border-t border-border pt-3 first:border-0 first:pt-0"
            >
              <div>
                <p>
                  <span className="mr-2 text-xs uppercase text-slate-500">
                    {c.direction === "outbound" ? "Out" : c.direction === "inbound" ? "In" : "Internal"}
                  </span>
                  {displayName ?? otherParty}
                </p>
                <p className="text-xs text-slate-500">
                  {new Date(c.startedAt).toLocaleString()} · {c.disposition} · {formatDuration(c.billsecSec)}
                  {c.callerContactId && (
                    <>
                      {" · "}
                      <Link href={`/agent?contact=${c.callerContactId}`} className="text-cyan hover:underline">
                        View in CRM
                      </Link>
                    </>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {c.recordingUrl && (
                  <audio controls preload="none" className="h-8" src={c.recordingUrl}>
                    <track kind="captions" />
                  </audio>
                )}
                <button
                  onClick={() => makeCall(otherParty)}
                  className="rounded-lg border border-border px-3 py-1 text-xs text-cyan hover:border-cyan"
                >
                  Call
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
