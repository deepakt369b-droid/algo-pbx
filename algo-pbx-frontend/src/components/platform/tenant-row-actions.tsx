"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { TenantManageModal } from "@/components/platform/tenant-manage-modal";

// Makes each /platform/tenants row clickable, opening the tenant management
// modal (W1). Split out of the page (a Server Component) because the click
// handler needs client-side state. All formatting/derivation (tunnel status,
// compliance, billing access) stays in the server component — this file only
// renders the already-computed values and owns the "which modal is open"
// state.
//
// `data-testid="tenant-row"` / `data-slug` are preserved verbatim — existing
// e2e specs key off them. The slug cell stays a real `Link` to the full
// detail page with `stopPropagation` so it still navigates there directly
// instead of opening the modal.

export interface TenantRowData {
  id: string;
  slug: string;
  workspaceHost: string;
  name: string;
  complianceLabel: string | null;
  complianceSummary: string | null;
  plan: string;
  extensionsUsed: number;
  seats: number;
  billingStatus: string;
  billingTone: "neutral" | "success" | "warning" | "danger";
  billingNote: string | null;
  paidUntil: string;
  tunnelLabel: string;
  tunnelTone: "neutral" | "success" | "warning" | "danger";
  createdAt: string;
}

export function TenantRows({ rows }: { rows: TenantRowData[] }) {
  const [openTenantId, setOpenTenantId] = useState<string | null>(null);

  return (
    <>
      {rows.map((t) => (
        <tr
          key={t.id}
          data-testid="tenant-row"
          data-slug={t.slug}
          role="button"
          tabIndex={0}
          onClick={() => setOpenTenantId(t.id)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setOpenTenantId(t.id);
            }
          }}
          className="cursor-pointer border-b transition-colors last:border-0 hover:bg-surface-hover [border-color:rgb(var(--hairline))]"
        >
          <td className="px-4 py-3">
            <Link
              href={`/platform/tenants/${t.id}`}
              onClick={(e) => e.stopPropagation()}
              className="font-mono text-accent underline-offset-2 hover:underline"
            >
              {t.slug}
            </Link>
            <span className="block text-[11px] text-tertiary">{t.workspaceHost}</span>
          </td>
          <td className="px-4 py-3 text-primary">
            {t.name}
            {t.complianceLabel && (
              <span
                title={t.complianceSummary ?? undefined}
                data-testid="compliance-warning"
                className="ml-2 rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning"
              >
                {t.complianceLabel}
              </span>
            )}
          </td>
          <td className="px-4 py-3 text-secondary">{t.plan}</td>
          <td className="px-4 py-3 tabular-nums text-secondary">
            {t.extensionsUsed}/{t.seats}
          </td>
          <td className="px-4 py-3">
            <Badge tone={t.billingTone}>{t.billingStatus}</Badge>
            {t.billingNote && <span className="ml-1.5 text-[11px] text-tertiary">{t.billingNote}</span>}
          </td>
          <td className="px-4 py-3 tabular-nums text-secondary">{t.paidUntil}</td>
          <td className="px-4 py-3">
            <Badge tone={t.tunnelTone}>{t.tunnelLabel}</Badge>
          </td>
          <td className="px-4 py-3 tabular-nums text-tertiary">{t.createdAt}</td>
        </tr>
      ))}

      {openTenantId && (
        <TenantManageModal
          tenantId={openTenantId}
          open
          onClose={() => setOpenTenantId(null)}
        />
      )}
    </>
  );
}
