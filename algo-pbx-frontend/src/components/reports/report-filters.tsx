"use client";

import { useEffect, useState } from "react";
import { Select, type SelectOption } from "@/components/ui";
import type { ReportFilterState } from "./use-report-query";

interface AgentRow {
  id: string;
  name: string;
  extension: string | null;
}

// The one control that drives every chart in the Reports hub. Its state is
// owned by the page and passed to each card's useReportQuery, which appends
// ?agentId=&from=&to= to its request.
export function ReportFilters({
  value,
  onChange,
}: {
  value: ReportFilterState;
  onChange: (next: ReportFilterState) => void;
}) {
  const [agents, setAgents] = useState<AgentRow[]>([]);

  useEffect(() => {
    fetch("/api/admin/reports/agents")
      .then((r) => r.json())
      .then((d) => setAgents(d.rows ?? []))
      .catch(() => setAgents([]));
  }, []);

  const agentOptions: SelectOption<string>[] = [
    { value: "", label: "All agents" },
    ...agents.map((a) => ({
      value: a.id,
      label: a.extension ? `${a.name} · ${a.extension}` : a.name,
    })),
  ];

  const inputCls =
    "h-10 rounded-[var(--radius)] border bg-surface px-3 text-sm text-primary [border-color:rgb(var(--hairline))] focus-visible:outline-none";

  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-tertiary">Agent</span>
        <Select
          className="w-56"
          aria-label="Filter by agent"
          value={value.agentId ?? ""}
          onChange={(v) => onChange({ ...value, agentId: v || null })}
          options={agentOptions}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-tertiary">From</span>
        <input
          type="date"
          className={inputCls}
          value={value.from}
          max={value.to}
          onChange={(e) => onChange({ ...value, from: e.target.value })}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-tertiary">To</span>
        <input
          type="date"
          className={inputCls}
          value={value.to}
          min={value.from}
          onChange={(e) => onChange({ ...value, to: e.target.value })}
        />
      </label>
    </div>
  );
}
