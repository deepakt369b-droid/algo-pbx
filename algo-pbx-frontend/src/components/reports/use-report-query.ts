"use client";

import { useEffect, useState } from "react";

export interface ReportFilterState {
  agentId: string | null;
  from: string; // yyyy-mm-dd
  to: string; // yyyy-mm-dd
}

export function filtersToQuery(f: ReportFilterState): string {
  const p = new URLSearchParams();
  if (f.agentId) p.set("agentId", f.agentId);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  return p.toString();
}

// Shared fetch hook for every Reports card. Re-runs whenever the shared
// <ReportFilters> state changes. Returns [] + loading:true until the first
// response lands so every card can show a <Skeleton> (Doherty).
export function useReportQuery<T>(
  path: string,
  filters: ReportFilterState,
): { rows: T[]; loading: boolean; error: boolean } {
  const [rows, setRows] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const qs = filtersToQuery(filters);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    fetch(`${path}?${qs}`)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json();
      })
      .then((data) => {
        if (!cancelled) setRows(data.rows ?? []);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, qs]);

  return { rows, loading, error };
}

export function defaultFilterState(): ReportFilterState {
  const today = new Date();
  const from = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { agentId: null, from: iso(from), to: iso(today) };
}
