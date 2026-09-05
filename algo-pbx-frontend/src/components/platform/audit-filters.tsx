"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { X } from "lucide-react";
import { Input, Label } from "@/components/ui/input";

// Audit filters. URL-driven for the same reason the tenant list's are: an
// investigator's filtered view should be shareable as a link, and a CSV
// export should provably cover the same set as the screen it came from —
// which it does here, because the export link is built from these same query
// parameters.

const selectClass =
  "h-9 w-full rounded-[var(--radius)] border bg-surface px-2 text-[13px] text-primary [border-color:rgb(var(--hairline))]";

export function AuditFilters({
  actions,
  actors,
  tenants,
  current,
}: {
  actions: string[];
  actors: Array<{ id: string; email: string }>;
  tenants: Array<{ id: string; slug: string }>;
  current: { action?: string; actorId?: string; tenantId?: string; from?: string; to?: string };
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  function apply(next: Record<string, string>) {
    const sp = new URLSearchParams();
    const merged = { ...current, ...next };
    for (const [k, v] of Object.entries(merged)) if (v) sp.set(k, v);
    // Any filter change resets pagination — keeping a cursor from the
    // previous filter would silently start the list part-way through a
    // different result set.
    sp.delete("cursor");
    startTransition(() => router.push(`/platform/audit?${sp.toString()}`));
  }

  const hasFilter = Boolean(
    current.action || current.actorId || current.tenantId || current.from || current.to
  );

  return (
    <div
      className="grid gap-3 rounded-[var(--radius)] border p-3 sm:grid-cols-2 lg:grid-cols-5 [border-color:rgb(var(--hairline))]"
      data-testid="audit-filters"
    >
      <div className="space-y-1.5">
        <Label htmlFor="f-action">Action</Label>
        <select
          id="f-action"
          className={selectClass}
          value={current.action ?? ""}
          onChange={(e) => apply({ action: e.target.value })}
          data-testid="filter-action"
        >
          <option value="">All actions</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="f-actor">Actor</Label>
        <select
          id="f-actor"
          className={selectClass}
          value={current.actorId ?? ""}
          onChange={(e) => apply({ actorId: e.target.value })}
          data-testid="filter-actor"
        >
          <option value="">All actors</option>
          {actors.map((a) => (
            <option key={a.id} value={a.id}>
              {a.email}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="f-tenant">Tenant</Label>
        <select
          id="f-tenant"
          className={selectClass}
          value={current.tenantId ?? ""}
          onChange={(e) => apply({ tenantId: e.target.value })}
          data-testid="filter-tenant"
        >
          <option value="">All tenants</option>
          {tenants.map((t) => (
            <option key={t.id} value={t.id}>
              {t.slug}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="f-from">From</Label>
        <Input
          id="f-from"
          type="date"
          value={current.from ?? ""}
          onChange={(e) => apply({ from: e.target.value })}
          data-testid="filter-from"
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="f-to">To</Label>
        <Input
          id="f-to"
          type="date"
          value={current.to ?? ""}
          onChange={(e) => apply({ to: e.target.value })}
          data-testid="filter-to"
        />
      </div>

      {hasFilter && (
        <div className="sm:col-span-2 lg:col-span-5">
          <button
            type="button"
            onClick={() =>
              startTransition(() => router.push("/platform/audit"))
            }
            data-testid="clear-audit-filters"
            className="inline-flex items-center gap-1 text-[12px] text-secondary hover:text-primary"
          >
            <X size={13} /> Clear filters
          </button>
          {pending && <span className="ml-2 text-[11px] text-tertiary">Filtering…</span>}
        </div>
      )}
    </div>
  );
}
