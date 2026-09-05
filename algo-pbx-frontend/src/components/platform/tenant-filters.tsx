"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useState, useTransition } from "react";
import { Search, X } from "lucide-react";
import { Input } from "@/components/ui/input";

// Search + status filters for the tenant list.
//
// State lives in the URL, not in this component: a filtered view is then
// linkable and back-button-friendly, and the server component does the actual
// filtering in SQL rather than shipping every tenant to the browser to hide
// most of them. This component only edits the query string.

const STATUSES = ["TRIAL", "ACTIVE", "SUSPENDED", "OFFBOARDED"] as const;
const BILLING = ["TRIAL", "ACTIVE", "PAST_DUE", "SUSPENDED"] as const;

export function TenantFilters({
  q,
  status,
  billing,
}: {
  q: string;
  status: string;
  billing: string;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState(q);

  function apply(next: Record<string, string>) {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) {
      if (v) sp.set(k, v);
      else sp.delete(k);
    }
    startTransition(() => router.push(`/platform/tenants?${sp.toString()}`));
  }

  const hasFilter = Boolean(q || status || billing);

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="tenant-filters">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          apply({ q: query.trim() });
        }}
        className="relative"
      >
        <Search
          size={14}
          className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-tertiary"
          aria-hidden
        />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search slug or name…"
          aria-label="Search tenants"
          data-testid="tenant-search"
          className="w-56 pl-8"
        />
      </form>

      <select
        value={status}
        onChange={(e) => apply({ status: e.target.value })}
        aria-label="Filter by status"
        data-testid="filter-status"
        className="h-9 rounded-[var(--radius)] border bg-surface px-2 text-[13px] text-primary [border-color:rgb(var(--hairline))]"
      >
        <option value="">All statuses</option>
        {STATUSES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      <select
        value={billing}
        onChange={(e) => apply({ billing: e.target.value })}
        aria-label="Filter by billing status"
        data-testid="filter-billing"
        className="h-9 rounded-[var(--radius)] border bg-surface px-2 text-[13px] text-primary [border-color:rgb(var(--hairline))]"
      >
        <option value="">All billing</option>
        {BILLING.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>

      {hasFilter && (
        <button
          type="button"
          onClick={() => {
            setQuery("");
            apply({ q: "", status: "", billing: "" });
          }}
          data-testid="clear-filters"
          className="inline-flex items-center gap-1 rounded-[var(--radius)] px-2 py-1.5 text-[12px] text-secondary hover:bg-surface-hover hover:text-primary"
        >
          <X size={13} /> Clear
        </button>
      )}

      {pending && <span className="text-[11px] text-tertiary">Filtering…</span>}
    </div>
  );
}
