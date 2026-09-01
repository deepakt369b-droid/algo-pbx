"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, Skeleton } from "@/components/ui";
import { AnswerRateChart, CallVolumeChart } from "./charts";
import { useReportQuery, type ReportFilterState } from "./use-report-query";

interface AgentHoursRow {
  extension: string;
  agentName: string | null;
  agentEmail: string | null;
  totalTalkSeconds: number;
  callCount: number;
}

interface VolumeRow {
  day: string;
  answered: number;
  total: number;
  answerRate: number;
}

// Labels describe what the API actually computes — ROLLING windows
// (now-24h / now-7d / now-30d), not calendar periods.
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

// Kept from the original page: poll on an interval so a supervisor watching
// a shift sees it update without re-clicking a period button, and surface
// load errors instead of showing an ambiguous empty table.
const POLL_INTERVAL_MS = 30_000;

// The original "Agent Call Hours" report, UNCHANGED — same GET
// /api/admin/reports/agent-hours route, same billsec-based numbers, its own
// rolling-window selector (deliberately independent of the hub's shared
// date-range filter, which would change these numbers).
function AgentHours() {
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
    <Card>
      <CardHeader className="flex-row items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <CardTitle>Agent Call Hours</CardTitle>
          <p className="text-[13px] text-secondary">
            Answered talk time per agent (excludes ringing/hold). Monitoring only.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {PERIODS.map((p) => (
            <button
              key={p.value}
              onClick={() => setPeriod(p.value)}
              className={`rounded-[var(--radius-sm)] border px-2.5 py-1 text-xs transition-colors [border-color:rgb(var(--hairline))] ${
                period === p.value
                  ? "bg-accent-subtle text-accent"
                  : "text-tertiary hover:text-primary"
              }`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        {error && <p className="mb-3 text-xs text-danger">{error}</p>}
        {loading ? (
          <Skeleton className="h-40 w-full" />
        ) : rows.length === 0 ? (
          <p className="text-sm text-tertiary">No answered calls in this period.</p>
        ) : (
          <table className="w-full text-sm text-primary">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-tertiary [border-color:rgb(var(--hairline))]">
                <th className="pb-2">Agent</th>
                <th className="pb-2">Extension</th>
                <th className="pb-2 text-right">Calls</th>
                <th className="pb-2 text-right">Talk time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.extension} className="border-b last:border-0 [border-color:rgb(var(--hairline))]">
                  <td className="py-2">{r.agentName ?? "Unassigned"}</td>
                  <td className="py-2 text-secondary">{r.extension}</td>
                  <td className="py-2 text-right">{r.callCount}</td>
                  <td className="py-2 text-right">{formatHours(r.totalTalkSeconds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

export function TelephonyTab({ filters }: { filters: ReportFilterState }) {
  const { rows, loading } = useReportQuery<VolumeRow>(
    "/api/admin/reports/call-volume",
    filters,
  );

  return (
    <div className="flex flex-col gap-4">
      <AgentHours />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Call volume over time</CardTitle>
            <p className="text-[13px] text-secondary">Answered vs missed, per day.</p>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-[220px] w-full" />
            ) : rows.length === 0 ? (
              <p className="text-sm text-tertiary">No calls in this range.</p>
            ) : (
              <CallVolumeChart rows={rows} />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Answer rate</CardTitle>
            <p className="text-[13px] text-secondary">Answered ÷ total calls, per day.</p>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Skeleton className="h-[220px] w-full" />
            ) : rows.length === 0 ? (
              <p className="text-sm text-tertiary">No calls in this range.</p>
            ) : (
              <AnswerRateChart rows={rows} />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
