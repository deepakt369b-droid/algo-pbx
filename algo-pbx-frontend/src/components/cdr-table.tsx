"use client";

import { useEffect, useState } from "react";
import type { CdrRow } from "@/types";

// The API has always supported ?agent=&from=&to=&limit= filtering (Zod-
// validated in api/cdr/route.ts) — this UI finally exposes it. Date inputs
// feed the schema's date-or-datetime branch directly; the agent field
// matches its 3-6 digit extension regex.
export function CdrTable() {
  const [rows, setRows] = useState<CdrRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [agent, setAgent] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const load = async () => {
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (/^\d{3,6}$/.test(agent)) params.set("agent", agent);
    if (from) params.set("from", from);
    if (to) params.set("to", to);
    params.set("limit", "50");
    try {
      const res = await fetch(`/api/cdr?${params.toString()}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load records");
      setRows(data.rows ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load records.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- initial load only; refetch is explicit via Apply
  }, []);

  const applyFilters = () => {
    load();
  };

  const resetFilters = () => {
    setAgent("");
    setFrom("");
    setTo("");
    setLoading(true);
    fetch("/api/cdr?limit=50", { cache: "no-store" })
      .then((r) => r.json())
      .then((data) => setRows(data.rows ?? []))
      .finally(() => setLoading(false));
  };

  return (
    <div className="glass-card w-full max-w-4xl overflow-x-auto p-6">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-400">
        Call Detail Records
      </h2>

      <div className="mb-4 flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          Agent ext.
          <input
            value={agent}
            onChange={(e) => setAgent(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="1001"
            className="w-24 rounded border border-border bg-background px-2 py-1 text-sm text-slate-100 outline-none focus:border-cyan"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          From
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1 text-sm text-slate-100 outline-none focus:border-cyan"
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          To
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="rounded border border-border bg-background px-2 py-1 text-sm text-slate-100 outline-none focus:border-cyan"
          />
        </label>
        <button
          onClick={applyFilters}
          className="rounded bg-cyan px-3 py-1.5 text-xs font-medium text-background"
        >
          Apply
        </button>
        <button onClick={resetFilters} className="text-xs text-slate-400 hover:text-slate-200">
          Reset
        </button>
      </div>

      {loading && <p className="text-slate-500">Loading call records…</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!loading && !error && rows.length === 0 && (
        <p className="text-slate-500">No calls recorded yet.</p>
      )}
      {!loading && !error && rows.length > 0 && (
        <table className="w-full text-left text-sm">
          <thead className="text-slate-500">
            <tr>
              <th className="pb-2">Started</th>
              <th className="pb-2">From</th>
              <th className="pb-2">To</th>
              <th className="pb-2">Direction</th>
              <th className="pb-2">Duration</th>
              <th className="pb-2">Disposition</th>
              <th className="pb-2">Recording</th>
            </tr>
          </thead>
          <tbody className="text-slate-200">
            {rows.map((row) => (
              <tr key={row.id} className="border-t border-border">
                <td className="py-2">{new Date(row.startedAt).toLocaleString()}</td>
                <td className="py-2">{row.callerNumber}</td>
                <td className="py-2">{row.destination}</td>
                <td className="py-2">{row.direction}</td>
                <td className="py-2">{row.durationSec}s</td>
                <td className="py-2">{row.disposition}</td>
                <td className="py-2">
                  {row.recordingUrl ? (
                    <audio controls src={row.recordingUrl} className="h-8" />
                  ) : (
                    <span className="text-slate-600">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
