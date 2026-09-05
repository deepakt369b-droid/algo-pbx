"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PhoneOff, ShieldOff, Ban } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ConfirmActionDialog } from "@/components/platform-shell/confirm-action-dialog";
import { DependencyNotice } from "@/components/platform-shell/dependency-notice";
import {
  suspendBlastRadius,
  unsuspendBlastRadius,
  dialplanCutBlastRadius,
  dialplanRestoreBlastRadius,
  offboardBlastRadius,
} from "@/lib/platform/blast-radius";
import { type SerialisedTenantDetail, type PlatformRole, fmtDateTime } from "./types";

// Lifecycle actions. Three distinct actions, deliberately not one "status"
// dropdown — a dropdown makes "suspend login" and "stop their calls" adjacent
// options in the same menu, which is precisely the adjacency this design
// exists to prevent.
//
// The dialplan cut is in its own visually separated danger section, requires
// typing the tenant slug, and is owner-only. Offboarding likewise. Suspension
// is comparatively routine and reversible, and its confirmation says so.

type Action = "suspend" | "unsuspend" | "dialplan_cut" | "dialplan_restore" | "offboard" | null;

export function LifecycleTab({
  detail,
  role,
}: {
  detail: SerialisedTenantDetail;
  role: PlatformRole;
}) {
  const router = useRouter();
  const { tenant, counts } = detail;
  const [action, setAction] = useState<Action>(null);
  const [manifest, setManifest] = useState<Array<{ step: string; automated: boolean; detail: string }> | null>(null);
  const isOwner = role === "PLATFORM_OWNER";

  const suspended = tenant.status === "SUSPENDED";
  const offboarded = tenant.status === "OFFBOARDED";
  const cut = tenant.dialplanCutAt !== null;

  async function post(path: string, body: Record<string, unknown>) {
    const res = await fetch(`/api/platform/tenants/${tenant.id}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok) throw new Error((json?.error as string) ?? "The action failed. Nothing was changed.");
    router.refresh();
    return json;
  }

  async function submit(reason: string) {
    switch (action) {
      case "suspend":
        await post("suspend", { reason });
        break;
      case "unsuspend":
        await post("suspend", { reason, unsuspend: true });
        break;
      case "dialplan_cut":
        await post("dialplan-cut", { reason, confirmSlug: tenant.slug, acknowledgeOutage: true });
        break;
      case "dialplan_restore":
        await post("dialplan-cut", {
          reason,
          confirmSlug: tenant.slug,
          acknowledgeOutage: true,
          restore: true,
        });
        break;
      case "offboard": {
        const json = await post("offboard", { reason, confirmSlug: tenant.slug });
        setManifest(
          (json?.manifest as Array<{ step: string; automated: boolean; detail: string }>) ?? null
        );
        break;
      }
    }
  }

  const copy: Record<Exclude<Action, null>, { title: string; blast: string; confirm: string; typed?: string }> = {
    suspend: {
      title: "Suspend login",
      blast: suspendBlastRadius(tenant.name, counts.users),
      confirm: "Suspend login",
    },
    unsuspend: {
      title: "Restore login",
      blast: unsuspendBlastRadius(tenant.name, counts.users),
      confirm: "Restore login",
    },
    dialplan_cut: {
      title: "Cut dialplan — stops all calls",
      blast: dialplanCutBlastRadius(tenant.name),
      confirm: "Cut this tenant's calls",
      typed: tenant.slug,
    },
    dialplan_restore: {
      title: "Restore dialplan",
      blast: dialplanRestoreBlastRadius(tenant.name),
      confirm: "Restore calling",
      typed: tenant.slug,
    },
    offboard: {
      title: "Offboard tenant",
      blast: offboardBlastRadius(tenant.name, counts.users),
      confirm: "Offboard tenant",
      typed: tenant.slug,
    },
  };

  return (
    <div className="space-y-4" data-testid="lifecycle-tab">
      {/* --- Access (reversible, routine) ------------------------------- */}
      <Card>
        <CardContent className="space-y-3 p-5">
          <div className="flex items-start gap-3">
            <ShieldOff size={16} className="mt-0.5 shrink-0 text-secondary" aria-hidden />
            <div className="min-w-0 flex-1">
              <h2 className="text-[15px] font-semibold text-primary">Login access</h2>
              <p className="text-[12px] text-secondary">
                Suspension blocks the web UI for this tenant&apos;s users. It does not touch
                telephony — their calls continue, inbound and outbound.
              </p>
              {suspended && (
                <p className="mt-1 text-[12px] text-tertiary">
                  Suspended {fmtDateTime(tenant.suspendedAt)}.
                </p>
              )}
            </div>
            {isOwner && !offboarded && (
              <Button
                size="sm"
                variant={suspended ? "secondary" : "danger"}
                onClick={() => setAction(suspended ? "unsuspend" : "suspend")}
                data-testid={suspended ? "action-unsuspend" : "action-suspend"}
              >
                {suspended ? "Restore login" : "Suspend login"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* --- Telephony kill switch (isolated, typed confirmation) -------- */}
      {isOwner && !offboarded && (
        <Card className="border-danger/40">
          <CardContent className="space-y-3 p-5">
            <div className="flex items-start gap-3">
              <PhoneOff size={16} className="mt-0.5 shrink-0 text-danger" aria-hidden />
              <div className="min-w-0 flex-1">
                <h2 className="text-[15px] font-semibold text-danger">
                  Telephony kill switch
                </h2>
                <p className="text-[12px] text-secondary">
                  Stops all of this tenant&apos;s calls. This is a customer-visible outage, not a
                  billing lever. It is never triggered automatically — no lapsed payment, status
                  change or scheduled job can reach it.
                </p>
                {cut && (
                  <p className="mt-1 text-[12px] text-danger" data-testid="dialplan-cut-at">
                    Dialplan cut {fmtDateTime(tenant.dialplanCutAt)}.
                  </p>
                )}
              </div>
              <Button
                size="sm"
                variant={cut ? "secondary" : "danger"}
                onClick={() => setAction(cut ? "dialplan_restore" : "dialplan_cut")}
                data-testid={cut ? "action-dialplan-restore" : "action-dialplan-cut"}
              >
                {cut ? "Restore calling" : "Cut dialplan"}
              </Button>
            </div>

            <DependencyNotice
              feature="Dialplan cut enforcement"
              blockedOn="Wave 6 telephony namespacing — per-tenant dialplan contexts (from-agent-t<n>) do not exist yet, so there is no per-tenant dialplan to cut."
              evidence="The action records and audits the decision. It does NOT currently stop calls — an operator must act on the shared dialplan directly."
            />
          </CardContent>
        </Card>
      )}

      {/* --- Offboarding ------------------------------------------------ */}
      {isOwner && (
        <Card>
          <CardContent className="space-y-3 p-5">
            <div className="flex items-start gap-3">
              <Ban size={16} className="mt-0.5 shrink-0 text-secondary" aria-hidden />
              <div className="min-w-0 flex-1">
                <h2 className="text-[15px] font-semibold text-primary">Offboard</h2>
                <p className="text-[12px] text-secondary">
                  Ends the relationship: revoke the gateway certificate, regenerate the CRL, reload
                  OpenVPN, block the subnet, and end login. Data is never deleted — export is
                  offered first, and deletion happens only on an explicit customer request under
                  PDPL.
                </p>
                {offboarded && (
                  <p className="mt-1 text-[12px] text-tertiary">
                    Offboarded {fmtDateTime(tenant.offboardedAt)}.
                  </p>
                )}
              </div>
              {!offboarded && (
                <Button size="sm" variant="danger" onClick={() => setAction("offboard")} data-testid="action-offboard">
                  Offboard
                </Button>
              )}
            </div>

            {manifest && (
              <div className="space-y-1.5" data-testid="offboard-manifest">
                <p className="text-[12px] font-medium text-primary">
                  Offboarding recorded. Remaining manual steps:
                </p>
                <ul className="space-y-1">
                  {manifest.map((m) => (
                    <li
                      key={m.step}
                      className="flex items-start gap-2 text-[12px]"
                      data-step={m.step}
                      data-automated={m.automated}
                    >
                      <span className={m.automated ? "text-success" : "text-warning"}>
                        {m.automated ? "✓" : "○"}
                      </span>
                      <span className="text-secondary">{m.detail}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {!isOwner && (
        <p className="text-[12px] text-tertiary">
          Lifecycle actions are restricted to platform owners.
        </p>
      )}

      {action && (
        <ConfirmActionDialog
          open
          onClose={() => setAction(null)}
          title={copy[action].title}
          blastRadius={copy[action].blast}
          confirmLabel={copy[action].confirm}
          requireTypedConfirmation={copy[action].typed}
          typedConfirmationLabel="tenant slug"
          tone="danger"
          onConfirm={submit}
        />
      )}
    </div>
  );
}
