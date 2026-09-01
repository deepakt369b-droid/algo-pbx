"use client";

import type { ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle, Skeleton } from "@/components/ui";
import { DispositionsChart, DncTrendChart } from "./charts";
import { useReportQuery, type ReportFilterState } from "./use-report-query";

const money = (n: number) =>
  new Intl.NumberFormat("en-AE", {
    style: "currency",
    currency: "AED",
    maximumFractionDigits: 0,
  }).format(n);

function CardBody({
  loading,
  empty,
  emptyText = "No data in this range.",
  children,
}: {
  loading: boolean;
  empty: boolean;
  emptyText?: string;
  children: ReactNode;
}) {
  if (loading) return <Skeleton className="h-[220px] w-full" />;
  if (empty) return <p className="text-sm text-tertiary">{emptyText}</p>;
  return <>{children}</>;
}

interface PipelineRow {
  stageId: string;
  name: string;
  isWon: boolean;
  isLost: boolean;
  count: number;
  value: number;
  conversionPct: number | null;
}

function PipelineFunnel({ filters }: { filters: ReportFilterState }) {
  const { rows, loading } = useReportQuery<PipelineRow>(
    "/api/admin/reports/pipeline",
    filters,
  );
  const max = Math.max(1, ...rows.map((r) => r.count));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pipeline funnel</CardTitle>
        <p className="text-[13px] text-secondary">
          Deals by stage, with stage-to-stage conversion.
        </p>
      </CardHeader>
      <CardContent>
        <CardBody loading={loading} empty={rows.every((r) => r.count === 0)}>
          <ul className="flex flex-col gap-2.5">
            {rows.map((r) => (
              <li key={r.stageId} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between text-sm">
                  <span className="text-primary">{r.name}</span>
                  <span className="text-secondary">
                    {r.count} · {money(r.value)}
                    {r.conversionPct !== null && (
                      <span className="text-tertiary"> · {r.conversionPct}%</span>
                    )}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-surface-subtle">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${(r.count / max) * 100}%`,
                      background: r.isWon
                        ? "rgb(var(--success))"
                        : r.isLost
                          ? "rgb(var(--danger))"
                          : "rgb(var(--accent))",
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </CardBody>
      </CardContent>
    </Card>
  );
}

function Dispositions({ filters }: { filters: ReportFilterState }) {
  const { rows, loading } = useReportQuery<{ outcome: string; count: number }>(
    "/api/admin/reports/dispositions",
    filters,
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Call dispositions</CardTitle>
        <p className="text-[13px] text-secondary">Logged outcomes across the range.</p>
      </CardHeader>
      <CardContent>
        <CardBody loading={loading} empty={rows.every((r) => r.count === 0)}>
          <DispositionsChart rows={rows} />
        </CardBody>
      </CardContent>
    </Card>
  );
}

interface LeaderboardRow {
  agentId: string;
  agentName: string;
  extension: string | null;
  calls: number;
  dispositions: number;
  dealsWon: number;
  wonValue: number;
}

function Leaderboard({ filters }: { filters: ReportFilterState }) {
  const { rows, loading } = useReportQuery<LeaderboardRow>(
    "/api/admin/reports/leaderboard",
    filters,
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Agent leaderboard</CardTitle>
        <p className="text-[13px] text-secondary">
          Calls handled, dispositions logged, deals won.
        </p>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <CardBody loading={loading} empty={rows.length === 0}>
          <table className="w-full text-sm text-primary">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-tertiary [border-color:rgb(var(--hairline))]">
                <th className="pb-2">Agent</th>
                <th className="pb-2 text-right">Calls</th>
                <th className="pb-2 text-right">Dispositions</th>
                <th className="pb-2 text-right">Deals won</th>
                <th className="pb-2 text-right">Won value</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.agentId}
                  className="border-b last:border-0 [border-color:rgb(var(--hairline))]"
                >
                  <td className="py-2">
                    {r.agentName}
                    {r.extension && <span className="text-tertiary"> · {r.extension}</span>}
                  </td>
                  <td className="py-2 text-right">{r.calls}</td>
                  <td className="py-2 text-right">{r.dispositions}</td>
                  <td className="py-2 text-right">{r.dealsWon}</td>
                  <td className="py-2 text-right">{money(r.wonValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      </CardContent>
    </Card>
  );
}

const BUCKET_COLOR: Record<string, string> = {
  overdue: "rgb(var(--danger))",
  today: "rgb(var(--warning))",
  thisWeek: "rgb(var(--accent))",
  later: "rgb(var(--text-tertiary))",
  noDueDate: "rgb(var(--text-tertiary))",
};

function TasksDue({ filters }: { filters: ReportFilterState }) {
  const { rows, loading } = useReportQuery<{ bucket: string; key: string; count: number }>(
    "/api/admin/reports/tasks-due",
    filters,
  );
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Follow-up tasks due</CardTitle>
        <p className="text-[13px] text-secondary">Open tasks by due date (now-relative).</p>
      </CardHeader>
      <CardContent>
        <CardBody loading={loading} empty={rows.every((r) => r.count === 0)} emptyText="No open tasks.">
          <ul className="flex flex-col gap-2.5">
            {rows.map((r) => (
              <li key={r.key} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between text-sm">
                  <span className="text-primary">{r.bucket}</span>
                  <span className="text-secondary">{r.count}</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-surface-subtle">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${(r.count / max) * 100}%`,
                      background: BUCKET_COLOR[r.key] ?? "rgb(var(--accent))",
                    }}
                  />
                </div>
              </li>
            ))}
          </ul>
        </CardBody>
      </CardContent>
    </Card>
  );
}

interface TopContactRow {
  contactId: string;
  name: string;
  company: string | null;
  interactions: number;
}

function TopContacts({ filters }: { filters: ReportFilterState }) {
  const { rows, loading } = useReportQuery<TopContactRow>(
    "/api/admin/reports/top-contacts",
    filters,
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Top contacts by interaction</CardTitle>
        <p className="text-[13px] text-secondary">Most activity in the range (top 10).</p>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <CardBody loading={loading} empty={rows.length === 0}>
          <table className="w-full text-sm text-primary">
            <thead>
              <tr className="border-b text-left text-xs uppercase tracking-wide text-tertiary [border-color:rgb(var(--hairline))]">
                <th className="pb-2">Contact</th>
                <th className="pb-2">Company</th>
                <th className="pb-2 text-right">Interactions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.contactId}
                  className="border-b last:border-0 [border-color:rgb(var(--hairline))]"
                >
                  <td className="py-2">{r.name}</td>
                  <td className="py-2 text-secondary">{r.company ?? "—"}</td>
                  <td className="py-2 text-right">{r.interactions}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardBody>
      </CardContent>
    </Card>
  );
}

function DncTrend({ filters }: { filters: ReportFilterState }) {
  const { rows, loading } = useReportQuery<{ day: string; total: number }>(
    "/api/admin/reports/dnc-trend",
    filters,
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Do-not-call trend</CardTitle>
        <p className="text-[13px] text-secondary">Blocklist entries added per day.</p>
      </CardHeader>
      <CardContent>
        <CardBody loading={loading} empty={rows.length === 0}>
          <DncTrendChart rows={rows} />
        </CardBody>
      </CardContent>
    </Card>
  );
}

export function CrmTab({ filters }: { filters: ReportFilterState }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <PipelineFunnel filters={filters} />
      <Dispositions filters={filters} />
      <Leaderboard filters={filters} />
      <TasksDue filters={filters} />
      <TopContacts filters={filters} />
      <DncTrend filters={filters} />
    </div>
  );
}
