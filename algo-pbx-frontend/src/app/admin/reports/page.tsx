"use client";

import { useState } from "react";
import { Tabs } from "@/components/ui";
import { ReportFilters } from "@/components/reports/report-filters";
import { TelephonyTab } from "@/components/reports/telephony-tab";
import { CrmTab } from "@/components/reports/crm-tab";
import { defaultFilterState } from "@/components/reports/use-report-query";

// Reports hub. One shared <ReportFilters> (agent + date range) drives every
// chart in both tabs — its state lives here and is threaded into each card's
// useReportQuery, which appends ?agentId=&from=&to= to its request. All data
// comes from GET /api/admin/reports/* (each requireStaffSession + groupBy).
// The Telephony tab keeps the original "Agent Call Hours" table verbatim
// (its own rolling-window selector, same agent-hours route, same numbers).
export default function ReportsPage() {
  const [filters, setFilters] = useState(defaultFilterState);

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-primary">Reports</h1>
        <p className="text-sm text-secondary">
          Telephony and CRM performance. The filters below apply to every chart.
        </p>
      </div>

      <ReportFilters value={filters} onChange={setFilters} />

      <Tabs
        tabs={[
          { label: "Telephony", content: <TelephonyTab filters={filters} /> },
          { label: "CRM Insights", content: <CrmTab filters={filters} /> },
        ]}
      />
    </div>
  );
}
