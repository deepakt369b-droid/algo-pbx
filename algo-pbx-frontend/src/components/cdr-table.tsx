"use client";

import { useEffect, useState } from "react";
import type { CdrRow } from "@/types";

export function CdrTable() {
  const [rows, setRows] = useState<CdrRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/cdr?limit=50")
      .then((r) => r.json())
      .then((data) => setRows(data.rows ?? []))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-slate-500">Loading call records…</p>;

  return (
    <div className="glass-card w-full max-w-4xl overflow-x-auto p-6">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-400">
        Call Detail Records
      </h2>
      {rows.length === 0 ? (
        <p className="text-slate-500">No calls recorded yet.</p>
      ) : (
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
