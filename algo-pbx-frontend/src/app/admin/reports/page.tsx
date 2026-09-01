"use client";

import { useCallback, useEffect, useState } from "react";

interface AgentHoursRow {
  extension: string;
  agentName: string | null;
  agentEmail: string | null;
  totalTalkSeconds: number;
  callCount: number;
}

// Labels describe what the API actually computes — ROLLING windows
// (now-24h / now-7d / now-30d), not calendar periods. The old labels said
// "Today/This week/This month", which misstated the data.
const PERIODS = [
  { value: "day", label: "Last 24h" },
  { value: "week", label: "Last 7 days" },
  { value: "month", label: "Last 30 days" },
  { value: "all", label: "All time" },
] as const;

function formatHours(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

// Talk-time-per-agent reporting (day/week/month/all-time). Reads
// GET /api/admin/reports/agent-hours, which sums CallDetailRecord.billsecSec
// (answered talk time, not ring/hold time) grouped by agent extension.
// See that route's own header comment for the one caveat worth knowing:
// this is reporting/monitoring, not a payroll-grade number.
// Confirmed live 2026-08-29: this page fetched only on period change, with
// no polling and no error surfacing. Combined with the CDR mapper bugs
// fixed the same session (agentExtension always NULL), the page always
// looked stale/empty with nothing to tell an admin watching it whether that
// meant "no calls" or "broken" — the exact D7 failure pattern (see
// agent-missed-calls.tsx / agent-call-log.tsx for the same fix applied
// there). A supervisor watching this during a shift needs it to update on
// its own, not just when they happen to click a period button again.
const POLL_INTERVAL_MS = 30_000;

export default function AgentHoursReportPage() {
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["value"]>("day");
  const [rows, setRows] = useState<AgentHoursRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((p: string) => {
    setError(null);
    fetch(`/api/admin/reports/agent-hours?period=${p}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Load failed (${r.status})`);
        return r.json();
      })
      .then((data) => setRows(data.rows ?? []))
      .catch(() => setError("Could not load report data."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    setLoading(true);
    load(period);
    const interval = setInterval(() => load(period), POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [period, load]);

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-primary">Agent Call Hours</h1>
      <p className="max-w-xl text-center text-xs text-tertiary">
        Answered talk time per agent (excludes ringing/hold time). Reporting and monitoring only.
      </p>

      <div className="flex gap-2">
        {PERIODS.map((p) => (
          <button
            key={p.value}
            onClick={() => setPeriod(p.value)}
            className={`rounded-lg border px-3 py-1.5 text-xs ${period === p.value ? "border-cyan text-cyan" : "border-border text-secondary"}`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="glass-card w-full max-w-2xl overflow-x-auto p-6">
        {error && <p className="mb-3 text-xs text-danger">{error}</p>}
        {rows.length === 0 ? (
          <p className="text-tertiary">{loading ? "Loading…" : "No answered calls in this period."}</p>
        ) : (
          <table className="w-full text-sm text-primary">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-tertiary">
                <th className="pb-2">Agent</th>
                <th className="pb-2">Extension</th>
                <th className="pb-2 text-right">Calls</th>
                <th className="pb-2 text-right">Talk time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.extension} className="border-b border-border last:border-0">
                  <td className="py-2">{r.agentName ?? "Unassigned"}</td>
                  <td className="py-2 text-secondary">{r.extension}</td>
                  <td className="py-2 text-right">{r.callCount}</td>
                  <td className="py-2 text-right">{formatHours(r.totalTalkSeconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
