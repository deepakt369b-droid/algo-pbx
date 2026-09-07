"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ConfirmActionDialog } from "@/components/platform-shell/confirm-action-dialog";
import { fmtDateTime } from "@/components/platform/tenant-detail/types";

// The cross-tenant geo-lock queue's row list. Two disjoint row kinds, per
// GeoLocksPage's own comment:
//   "request"  — a tenant admin has filed an ExtensionUnlockRequest.
//                 Approve or Deny act on that request's id.
//   "silent"   — the extension is locked and no one has asked yet. There is
//                 no request row to approve or deny, so the only action is
//                 "Unlock now", which the API treats as an approval against
//                 the extension directly (see the route's own comment for
//                 the `request:`/`extension:` id-prefix scheme this drives).
//
// Both actions post through the SAME route family
// (POST /api/platform/geo-locks/[id]) so there is one audited code path for
// "an owner decided to restore this extension's access", not two.

export interface GeoLockRow {
  kind: "request" | "silent";
  id: string;
  tenant: { id: string; slug: string; name: string };
  extensionId: string;
  extensionNumber: string;
  lockedAt: string | null;
  lockedReason: string | null;
  lastFailureAt: string | null;
  lastFailureCountry: string | null;
  lastFailureIp: string | null;
  lastFailureAsn: number | null;
  requestedAt: string | null;
  requestedByName: string | null;
  requestedByEmail: string | null;
  requestedReason: string | null;
}

type PendingAction = { row: GeoLockRow; decision: "approve" | "deny" } | null;

export function GeoLocksList({ rows }: { rows: GeoLockRow[] }) {
  const router = useRouter();
  const [pending, setPending] = useState<PendingAction>(null);

  async function submit(reason: string) {
    if (!pending) return;
    const { row, decision } = pending;
    const routeId = row.kind === "request" ? `request:${row.id}` : `extension:${row.extensionId}`;
    const res = await fetch(`/api/platform/geo-locks/${encodeURIComponent(routeId)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, reason }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(err?.error ?? "The action failed. Nothing was changed.");
    }
    router.refresh();
  }

  if (rows.length === 0) {
    return (
      <Card>
        <CardContent className="p-5">
          <p className="py-2 text-[13px] text-tertiary" data-testid="geo-locks-empty">
            Nothing needs a decision. No pending unlock requests, and no extension is geo-locked.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <ul className="flex flex-col gap-3" data-testid="geo-locks-list">
        {rows.map((row) => (
          <li key={`${row.kind}:${row.id}`}>
            <Card>
              <CardContent className="flex flex-wrap items-start justify-between gap-4 p-5">
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/platform/tenants/${row.tenant.id}?tab=geo`}
                      className="text-[14px] font-semibold text-primary hover:underline"
                    >
                      {row.tenant.name}
                    </Link>
                    <span className="font-mono text-[12px] text-tertiary">{row.tenant.slug}</span>
                    <Badge tone="danger">Ext {row.extensionNumber}</Badge>
                    {row.kind === "silent" ? (
                      <Badge tone="warning">No request filed</Badge>
                    ) : (
                      <Badge tone="warning">Unlock requested</Badge>
                    )}
                  </div>

                  <dl className="grid gap-x-6 gap-y-1 text-[12px] sm:grid-cols-2">
                    <div>
                      <dt className="inline text-tertiary">Locked at </dt>
                      <dd className="inline text-primary">{fmtDateTime(row.lockedAt)}</dd>
                    </div>
                    <div>
                      <dt className="inline text-tertiary">Reason </dt>
                      <dd className="inline text-primary">{row.lockedReason ?? "—"}</dd>
                    </div>
                    <div>
                      <dt className="inline text-tertiary">Last failure </dt>
                      <dd className="inline text-primary">
                        {row.lastFailureCountry ?? "unknown country"} · {row.lastFailureIp ?? "unknown ip"}
                        {row.lastFailureAsn ? ` · AS${row.lastFailureAsn}` : ""}
                      </dd>
                    </div>
                    <div>
                      <dt className="inline text-tertiary">At </dt>
                      <dd className="inline text-primary">{fmtDateTime(row.lastFailureAt)}</dd>
                    </div>
                  </dl>

                  {row.kind === "request" && (
                    <div className="rounded-[var(--radius)] border p-3 [border-color:rgb(var(--hairline))]">
                      <p className="text-[12px] text-secondary">
                        Requested {fmtDateTime(row.requestedAt)} by{" "}
                        <span className="font-medium text-primary">{row.requestedByName}</span>{" "}
                        <span className="text-tertiary">{row.requestedByEmail}</span>
                      </p>
                      <p className="mt-1 text-[12px] italic text-secondary">{row.requestedReason}</p>
                    </div>
                  )}
                </div>

                <div className="flex shrink-0 flex-col gap-2">
                  {row.kind === "request" ? (
                    <>
                      <Button
                        size="sm"
                        onClick={() => setPending({ row, decision: "approve" })}
                        data-testid="action-approve-unlock"
                      >
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setPending({ row, decision: "deny" })}
                        data-testid="action-deny-unlock"
                      >
                        Deny
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      onClick={() => setPending({ row, decision: "approve" })}
                      data-testid="action-unlock-now"
                    >
                      Unlock now
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          </li>
        ))}
      </ul>

      {pending && (
        <ConfirmActionDialog
          open
          onClose={() => setPending(null)}
          title={
            pending.decision === "approve"
              ? `Unlock extension ${pending.row.extensionNumber}`
              : `Deny unlock for extension ${pending.row.extensionNumber}`
          }
          blastRadius={
            pending.decision === "approve"
              ? `This clears the geo-lock on extension ${pending.row.extensionNumber} (${pending.row.tenant.name}), resets its failure count to zero, and re-provisions PJSIP so the endpoint can register again immediately.`
              : `This denies the unlock request for extension ${pending.row.extensionNumber} (${pending.row.tenant.name}). The extension stays locked; the tenant admin can file a new request.`
          }
          confirmLabel={pending.decision === "approve" ? "Unlock" : "Deny"}
          tone={pending.decision === "approve" ? "default" : "danger"}
          onConfirm={submit}
        />
      )}
    </>
  );
}
