"use client";

import { useCallback, useEffect, useState } from "react";

interface RecordingRow {
  id: string;
  recordingUrl: string;
  createdAt: string;
  cdr: {
    callerNumber: string;
    destination: string;
    direction: string;
    startedAt: string;
    durationSec: number;
  };
}

// Agent-facing recording list. The only mutation available here is "Hide" —
// deliberately not "Delete": the requirement is verbatim "the agent side
// deletion will not delete the recording," so this UI doesn't even offer a
// button that could be mistaken for one. Admin/supervisor retain full
// visibility and a separate hard-delete regardless of what's hidden here
// (see /admin/cdr and the ADMIN-only DELETE /api/admin/recordings/[id]).
export function AgentRecordings() {
  const [recordings, setRecordings] = useState<RecordingRow[]>([]);
  const [loading, setLoading] = useState(true);
  // A failed load used to leave loading=true forever and the component
  // rendered null — indistinguishable from "no recordings". Errors now
  // surface; the list also polls so calls that just ended appear without
  // a remount.
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/recordings", { cache: "no-store" });
      if (!res.ok) throw new Error(`Load failed (${res.status})`);
      const data = await res.json();
      setRecordings(data.recordings ?? []);
    } catch {
      setError("Could not load recordings.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 10000);
    return () => clearInterval(interval);
  }, [load]);

  const hide = async (id: string) => {
    try {
      const res = await fetch("/api/recordings/hide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setError("Could not hide that recording — try again.");
      return;
    }
    load();
  };

  if (loading && recordings.length === 0 && !error) return null;
  if (error && recordings.length === 0) {
    return (
      <div className="glass-card w-full max-w-2xl p-6">
        <p className="text-xs text-red-400">{error}</p>
      </div>
    );
  }
  if (recordings.length === 0) return null;

  return (
    <div className="glass-card w-full max-w-2xl p-6">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
        My Recent Recordings
      </h2>
      {error && <p className="mb-2 text-xs text-red-400">{error}</p>}
      <ul className="flex flex-col gap-3 text-sm text-slate-200">
        {recordings.map((r) => (
          <li key={r.id} className="flex items-center justify-between gap-3 border-t border-border pt-3 first:border-0 first:pt-0">
            <div>
              <p>
                {r.cdr.direction === "outbound" ? r.cdr.destination : r.cdr.callerNumber} —{" "}
                {new Date(r.cdr.startedAt).toLocaleString()}
              </p>
              <p className="text-xs text-slate-500">{r.cdr.durationSec}s</p>
            </div>
            <div className="flex items-center gap-3">
              <audio controls src={r.recordingUrl} className="h-8" />
              <button onClick={() => hide(r.id)} className="text-xs text-slate-500 hover:text-red-400">
                Hide
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
