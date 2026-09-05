"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Check, Circle } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { type SerialisedTenantDetail, type PlatformRole, fmtDate } from "./types";

// The per-tenant onboarding compliance checklist.
//
// Each item is a real regulatory or contractual artefact, and each stores a
// DATE rather than a tick — "when was this filed" is the question an auditor
// asks, and a boolean cannot answer it.
//
// An incomplete checklist never blocks anything technical. That is deliberate:
// paperwork legitimately lags a technical setup, and a console that refused to
// record the customer would just move the record-keeping into somebody's
// inbox where nobody can see it. Instead the gap follows the tenant — the
// list row, this page's header, and the overview attention queue.

export function ComplianceChecklist({
  detail,
  role,
}: {
  detail: SerialisedTenantDetail;
  role: PlatformRole;
}) {
  const router = useRouter();
  const { tenant, compliance } = detail;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const canEdit = role === "PLATFORM_OWNER";

  async function toggle(itemId: string, filed: boolean) {
    setBusy(itemId);
    setError(null);
    try {
      const res = await fetch(`/api/platform/tenants/${tenant.id}/compliance`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ item: itemId, filed }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? "Could not update the checklist.");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the checklist.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-[15px] font-semibold text-primary">Compliance checklist</h2>
          <span
            data-testid="compliance-progress"
            className={`text-[12px] ${compliance.complete ? "text-success" : "text-warning"}`}
          >
            {compliance.filedCount} of {compliance.totalCount} filed
          </span>
        </div>

        <ul className="space-y-1" data-testid="compliance-checklist">
          {compliance.items.map((item) => {
            const filed = item.filedAt !== null;
            return (
              <li
                key={item.id}
                data-item={item.id}
                data-filed={filed}
                className="flex items-start gap-3 rounded-[var(--radius)] border p-3 [border-color:rgb(var(--hairline))]"
              >
                {filed ? (
                  <Check size={15} className="mt-0.5 shrink-0 text-success" aria-hidden />
                ) : (
                  <Circle size={15} className="mt-0.5 shrink-0 text-tertiary" aria-hidden />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-primary">{item.label}</p>
                  <p className="text-[12px] text-secondary">{item.why}</p>
                  <p className="mt-0.5 text-[11px] text-tertiary">
                    {filed ? `Filed ${fmtDate(item.filedAt)}` : "Not filed"}
                  </p>
                </div>
                {canEdit && (
                  <Button
                    size="sm"
                    variant={filed ? "ghost" : "secondary"}
                    disabled={busy === item.id}
                    onClick={() => toggle(item.id, !filed)}
                    data-testid={`compliance-toggle-${item.id}`}
                  >
                    {busy === item.id ? "…" : filed ? "Clear" : "Mark filed"}
                  </Button>
                )}
              </li>
            );
          })}
        </ul>

        {error && (
          <p role="alert" className="mt-3 text-[12px] text-danger">
            {error}
          </p>
        )}

        {!canEdit && (
          <p className="mt-3 text-[11px] text-tertiary">
            Only a platform owner can change these.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
