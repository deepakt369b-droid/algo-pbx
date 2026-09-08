"use client";

import { useState } from "react";
import Link from "next/link";
import { CrmTab } from "@/components/reports/crm-tab";
import { defaultFilterState } from "@/components/reports/use-report-query";

// Surfaces the existing CRM Insights analytics (pipeline funnel,
// dispositions, leaderboard, tasks due, top contacts, DNC trend — all
// already built and tested under /admin/reports's "CRM Insights" tab) on
// the admin DASHBOARD itself (owner-page enchanted-sphinx plan, W6: "in
// user admin dashboard we need to bring the crm related dashboard ... as an
// analytical view with graphs").
//
// Deliberately reuses <CrmTab> rather than re-implementing its charts —
// same data, same API routes (/api/admin/reports/*), same
// useReportQuery()/ReportFilterState machinery. The dashboard shows a fixed
// default range (last 30 days, every agent — defaultFilterState()) rather
// than embedding the full <ReportFilters> picker; anyone who wants to slice
// by agent or a custom range already has that on the full Reports page,
// linked below.
export function AdminDashboardCrmPanel() {
  const [filters] = useState(defaultFilterState);

  return (
    <section className="mt-6 flex w-full max-w-6xl flex-col gap-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">
          CRM overview (last 30 days)
        </h2>
        <Link href="/admin/reports" className="text-xs text-cyan hover:underline">
          Full reports →
        </Link>
      </div>
      <CrmTab filters={filters} />
    </section>
  );
}
