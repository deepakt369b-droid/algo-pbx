"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Dialog } from "@/components/ui/dialog";
import { TenantDetailTabs } from "@/components/platform/tenant-detail/tenant-detail-tabs";
import type { SerialisedTenantDetail, PlatformRole } from "@/components/platform/tenant-detail/types";

// Tenant management modal — opened by clicking a row on /platform/tenants
// (W1: "the click is not popping any window ... subscription management,
// extension management, current user geo location locking"). Rather than
// re-implementing subscription/users/geo panels a second time, this fetches
// the same payload the tenant detail PAGE renders
// (GET /api/platform/tenants/[id]/detail, backed by the same
// loadTenantDetail()) and reuses <TenantDetailTabs/> verbatim — so every
// action here (billing, users, geo, extensions) goes through the exact same
// tested routes and ConfirmActionDialog flow as the full detail page. The
// slug link on the row still navigates to that full page for anyone who
// prefers it; this modal is the fast path for the common case.
export function TenantManageModal({
  tenantId,
  open,
  onClose,
}: {
  tenantId: string;
  open: boolean;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<SerialisedTenantDetail | null>(null);
  const [role, setRole] = useState<PlatformRole | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDetail(null);
    setLoadError(null);
    fetch(`/api/platform/tenants/${tenantId}/detail`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r)))
      .then((json: { detail: SerialisedTenantDetail; role: PlatformRole }) => {
        setDetail(json.detail);
        setRole(json.role);
      })
      .catch(() => setLoadError("Could not load this tenant. Try the full detail page instead."));
  }, [open, tenantId]);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={detail ? `${detail.tenant.name} · ${detail.tenant.slug}` : "Loading tenant…"}
    >
      <div className="max-h-[70vh] overflow-y-auto">
        {loadError && (
          <p role="alert" className="text-[13px] text-danger">
            {loadError}
          </p>
        )}
        {!detail || !role ? (
          !loadError && <p className="py-8 text-center text-[13px] text-tertiary">Loading…</p>
        ) : (
          <>
            <TenantDetailTabs detail={detail} role={role} />
            <p className="mt-3 text-[11px] text-tertiary">
              Need the full page (compliance checklist, gateway, support access)?{" "}
              <Link
                href={`/platform/tenants/${tenantId}`}
                className="text-accent underline-offset-2 hover:underline"
              >
                Open tenant detail
              </Link>
              .
            </p>
          </>
        )}
      </div>
    </Dialog>
  );
}
