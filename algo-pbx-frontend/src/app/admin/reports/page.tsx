"use client";

import { useEffect, useState } from "react";

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
export default function AgentHoursReportPage() {
  const [period, setPeriod] = useState<(typeof PERIODS)[number]["value"]>("day");
  const [rows, setRows] = useState<AgentHoursRow[]>([]);

  useEffect(() => {
    fetch(`/api/admin/reports/agent-hours?period=${period}`)
      .then((r) => r.json())
      .then((data) => setRows(data.rows ?? []));
  }, [period]);

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-slate-100">Agent Call Hours</h1>
      <p className="max-w-xl text-center text-xs text-slate-500">
        Answered talk time per agent (excludes ringing/hold time). Reporting and monitoring only.
      </p>

      <div className="flex gap-2">
        {PERIODS.map((p) => (
          <button
            key={p.value}
            onClick={() => setPeriod(p.value)}
            className={`rounded-lg border px-3 py-1.5 text-xs ${period === p.value ? "border-cyan text-cyan" : "border-border text-slate-400"}`}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="glass-card w-full max-w-2xl overflow-x-auto p-6">
        {rows.length === 0 ? (
          <p className="text-slate-500">No answered calls in this period.</p>
        ) : (
          <table className="w-full text-sm text-slate-200">
            <thead>
              <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-slate-500">
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
                  <td className="py-2 text-slate-400">{r.extension}</td>
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
