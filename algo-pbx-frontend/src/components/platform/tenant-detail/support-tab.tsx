"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/input";
import { ConfirmActionDialog } from "@/components/platform-shell/confirm-action-dialog";
import { supportGrantBlastRadius } from "@/lib/platform/blast-radius";
import { type SerialisedTenantDetail, fmtDateTime } from "./types";

// Support access. A grant is the ONLY thing that lets any platform account —
// owner included — read this tenant's data. The console can list tenants and
// change billing without one; it cannot look at their calls.
//
// Two properties are surfaced prominently because they are promises made to
// the customer, not implementation details:
//   - the hard 24h ceiling, clamped server-side regardless of what is sent;
//   - the banner the tenant sees for as long as the grant is live.
// The history below is the same history the customer can see. If we would be
// uncomfortable with them reading a row, the answer is not to hide it.

const MAX_HOURS = 24;

export function SupportTab({ detail }: { detail: SerialisedTenantDetail }) {
  const router = useRouter();
  const { tenant } = detail;
  const [hours, setHours] = useState(2);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const now = Date.now();
  const grants = tenant.supportGrants.map((g) => ({
    ...g,
    live: g.revokedAt === null && new Date(g.expiresAt).getTime() > now,
  }));
  const live = grants.filter((g) => g.live);

  async function create(reason: string) {
    const res = await fetch("/api/platform/support-grants", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tenantId: tenant.id,
        reason,
        durationMinutes: Math.min(hours, MAX_HOURS) * 60,
      }),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(err?.error ?? "Could not create the grant.");
    }
    router.refresh();
  }

  async function revoke(id: string) {
    setBusy(id);
    setError(null);
    try {
      const res = await fetch(`/api/platform/support-grants/${id}/revoke`, { method: "POST" });
      if (!res.ok) {
        const err = (await res.json().catch(() => null)) as { reason?: string; error?: string } | null;
        throw new Error(err?.reason ?? err?.error ?? "Could not revoke the grant.");
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not revoke the grant.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="space-y-3 p-5">
          <h2 className="text-[15px] font-semibold text-primary">Request support access</h2>
          <p className="text-[12px] text-secondary">
            A time-boxed, reasoned grant is the only way to read this tenant&apos;s data — owners
            included. While it is live, {tenant.name} sees a banner naming you and the expiry, and
            the grant is written to both their audit log and ours.
          </p>

          <div className="flex flex-wrap items-end gap-3">
            <div className="w-40 space-y-1.5">
              <Label htmlFor="grant-hours">Duration (hours)</Label>
              <Input
                id="grant-hours"
                type="number"
                min={1}
                max={MAX_HOURS}
                value={hours}
                onChange={(e) =>
                  setHours(Math.max(1, Math.min(MAX_HOURS, Number(e.target.value) || 1)))
                }
                data-testid="grant-hours"
              />
            </div>
            <Button size="sm" onClick={() => setCreating(true)} data-testid="action-create-grant">
              Create grant
            </Button>
          </div>
          <p className="text-[11px] text-tertiary">
            Maximum {MAX_HOURS} hours. Longer requests are clamped by the server — there are no
            open-ended grants.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5">
          <div className="mb-3 flex items-baseline justify-between gap-3">
            <h2 className="text-[15px] font-semibold text-primary">Grant history</h2>
            <span className="text-[12px] text-tertiary">
              {live.length} active · {grants.length} total
            </span>
          </div>

          {error && (
            <p role="alert" className="mb-2 text-[12px] text-danger">
              {error}
            </p>
          )}

          {grants.length === 0 ? (
            <p className="py-2 text-[13px] text-tertiary">
              No platform user has ever been granted access to this tenant&apos;s data.
            </p>
          ) : (
            <ul className="space-y-2" data-testid="grant-history">
              {grants.map((g) => (
                <li
                  key={g.id}
                  data-testid="grant-row"
                  data-live={g.live}
                  className="flex flex-wrap items-start justify-between gap-3 rounded-[var(--radius)] border p-3 [border-color:rgb(var(--hairline))]"
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2 text-[13px] font-medium text-primary">
                      {g.platformUser.name}
                      <span className="font-normal text-tertiary">{g.platformUser.email}</span>
                      {g.live ? (
                        <Badge tone="warning">Active</Badge>
                      ) : g.revokedAt ? (
                        <Badge tone="neutral">Revoked</Badge>
                      ) : (
                        <Badge tone="neutral">Expired</Badge>
                      )}
                    </p>
                    <p className="text-[12px] italic text-secondary">{g.reason}</p>
                    <p className="text-[11px] text-tertiary">
                      Granted {fmtDateTime(g.grantedAt)} · {g.revokedAt ? "revoked" : "expires"}{" "}
                      {fmtDateTime(g.revokedAt ?? g.expiresAt)}
                    </p>
                  </div>
                  {g.live && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy === g.id}
                      onClick={() => revoke(g.id)}
                      data-testid="action-revoke-grant"
                    >
                      {busy === g.id ? "…" : "Revoke now"}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}

          <p className="mt-3 text-[11px] text-tertiary">
            This history is also visible to the customer. Nothing here is hidden from them.
          </p>
        </CardContent>
      </Card>

      {creating && (
        <ConfirmActionDialog
          open
          onClose={() => setCreating(false)}
          title="Create support grant"
          blastRadius={supportGrantBlastRadius(tenant.name, Math.min(hours, MAX_HOURS))}
          confirmLabel="Create grant"
          tone="default"
          onConfirm={create}
        />
      )}
    </div>
  );
}
