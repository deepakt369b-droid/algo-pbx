"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch, ApiError } from "@/lib/client/api";

interface RecordingRow {
  id: string;
  hiddenFromAgentAt: string | null;
  createdAt: string;
  recordingUrl: string;
  cdr: {
    uniqueId: string;
    callerNumber: string | null;
    destination: string | null;
    direction: string | null;
    startedAt: string | null;
    durationSec: number | null;
    agentExtension: string | null;
  };
}

function fmtDuration(s: number | null): string {
  if (!s || s < 0) return "—";
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

// Admin/supervisor recordings library. Before this the only way to hear a
// recording was the per-row <audio> in /admin/cdr, and the hard-delete
// route (DELETE /api/admin/recordings/[id]) had no UI at all. GET
// /api/recordings already returns every recording for staff (including
// agent-hidden ones), with canAccessRecording() enforced at the
// byte-serving layer — this page is a view over that.
export default function AdminRecordingsPage() {
  const [rows, setRows] = useState<RecordingRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [messageKind, setMessageKind] = useState<"ok" | "error">("ok");
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await apiFetch<{ recordings: RecordingRow[] }>("/api/recordings");
      setRows(data.recordings ?? []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load recordings.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return rows.filter((r) => {
      if (!showHidden && r.hiddenFromAgentAt) return false;
      if (!q) return true;
      return (
        (r.cdr.callerNumber ?? "").toLowerCase().includes(q) ||
        (r.cdr.destination ?? "").toLowerCase().includes(q) ||
        (r.cdr.agentExtension ?? "").toLowerCase().includes(q) ||
        r.cdr.uniqueId.toLowerCase().includes(q)
      );
    });
  }, [rows, filter, showHidden]);

  const toggleHidden = async (r: RecordingRow) => {
    setBusyId(r.id);
    setMessage(null);
    try {
      await apiFetch("/api/recordings/hide", {
        method: "POST",
        body: { id: r.id, hidden: !r.hiddenFromAgentAt },
      });
      setMessageKind("ok");
      setMessage(r.hiddenFromAgentAt ? "Recording un-hidden — agents can see it again." : "Recording hidden from agents.");
      await load();
    } catch (err) {
      setMessageKind("error");
      setMessage(err instanceof ApiError ? err.message : "Could not update this recording.");
    } finally {
      setBusyId(null);
    }
  };

  const hardDelete = async (r: RecordingRow) => {
    if (!confirm(`PERMANENTLY delete this recording (call ${r.cdr.uniqueId})? The audio file is unlinked from disk and cannot be recovered. This is logged in the audit trail.`)) return;
    setBusyId(r.id);
    setMessage(null);
    try {
      await apiFetch(`/api/admin/recordings/${r.id}`, { method: "DELETE" });
      setMessageKind("ok");
      setMessage("Recording permanently deleted.");
      await load();
    } catch (err) {
      setMessageKind("error");
      setMessage(err instanceof ApiError ? err.message : "Could not delete this recording (ADMIN only).");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-slate-100">Call Recordings</h1>

      {loadError && (
        <div className="w-full max-w-3xl rounded-lg border border-red-900 bg-red-950/40 px-4 py-2 text-center text-xs text-red-300">
          {loadError}
        </div>
      )}

      <div className="glass-card flex w-full max-w-3xl flex-col gap-3 p-6">
        <div className="flex flex-wrap items-center gap-3">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter by number, agent extension, or call id"
            className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
          />
          <label className="flex items-center gap-2 text-xs text-slate-400">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} />
            Show agent-hidden
          </label>
          <button onClick={load} className="rounded-lg border border-border px-3 py-2 text-xs text-slate-300 hover:border-cyan">
            Refresh
          </button>
        </div>
        {message && <p className={`text-xs ${messageKind === "error" ? "text-red-400" : "text-slate-500"}`}>{message}</p>}
        <p className="text-xs text-slate-600">
          {visible.length} recording{visible.length === 1 ? "" : "s"}. Playback and download stream through the byte-serving
          route, which re-checks access on every request.
        </p>
      </div>

      <div className="glass-card w-full max-w-3xl p-4">
        {visible.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">
            No recordings. They are created as inbound calls are answered (see <span className="text-slate-400">extensions.conf</span>&apos;s
            MixMonitor) and ingested by the CDR listener.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {visible.map((r) => (
              <li key={r.id} className="flex flex-col gap-2 py-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                  <span className="text-slate-200">
                    {r.cdr.direction === "inbound" ? "◀ " : "▶ "}
                    {r.cdr.callerNumber || "unknown"} → {r.cdr.destination || r.cdr.agentExtension || "—"}
                  </span>
                  <span className="text-xs text-slate-500">
                    {fmtWhen(r.cdr.startedAt || r.createdAt)} · {fmtDuration(r.cdr.durationSec)} · agent {r.cdr.agentExtension || "—"}
                  </span>
                </div>
                <audio controls preload="none" src={r.recordingUrl} className="h-8 w-full" />
                <div className="flex flex-wrap items-center gap-3 text-xs">
                  <a href={r.recordingUrl} download className="text-cyan hover:underline">
                    Download
                  </a>
                  {r.hiddenFromAgentAt ? (
                    <span className="text-yellow-500">hidden from agents ({fmtWhen(r.hiddenFromAgentAt)})</span>
                  ) : (
                    <span className="text-slate-600">visible to owning agent</span>
                  )}
                  <button
                    onClick={() => toggleHidden(r)}
                    disabled={busyId === r.id}
                    className="text-slate-400 hover:text-slate-200 disabled:opacity-50"
                  >
                    {r.hiddenFromAgentAt ? "Un-hide" : "Hide from agent"}
                  </button>
                  <button
                    onClick={() => hardDelete(r)}
                    disabled={busyId === r.id}
                    className="text-red-400 hover:text-red-300 disabled:opacity-50"
                  >
                    Delete permanently
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
