"use client";

import { useEffect, useState } from "react";

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

  const load = () => {
    fetch("/api/recordings")
      .then((r) => r.json())
      .then((data) => setRecordings(data.recordings ?? []))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  const hide = async (id: string) => {
    await fetch("/api/recordings/hide", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    load();
  };

  if (loading) return null;
  if (recordings.length === 0) return null;

  return (
    <div className="glass-card w-full max-w-2xl p-6">
      <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
        My Recent Recordings
      </h2>
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
