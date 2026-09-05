"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { ConfirmActionDialog } from "@/components/platform-shell/confirm-action-dialog";
import { TELEPHONY_UNAFFECTED_NOTE } from "@/lib/platform/blast-radius";
import { type SerialisedTenantDetail, type PlatformRole, fmtDate } from "./types";

// Billing — manual-first, owner-overridable.
//
// ============================================================================
// THERE IS NO DIALPLAN CONTROL ON THIS TAB, AND THERE NEVER WILL BE.
// ============================================================================
// Cutting a tenant's calls is not a billing action. It lives on the Lifecycle
// tab behind its own typed confirmation, and the acceptance suite asserts its
// ABSENCE from this tab specifically. Putting the two within one click of each
// other is how a suspension becomes an outage at 2am.
// ============================================================================
//
// Every rung of the ladder shown here governs web login only. The note at the
// bottom of this tab says so in the same words used in every confirmation
// dialog, because an operator who reads one phrasing here and another there
// will eventually conclude they mean different things.

const RUNG_COPY: Record<string, { label: string; tone: string }> = {
  ok: { label: "Good standing", tone: "text-success" },
  warning: { label: "In grace period", tone: "text-warning" },
  login_blocked: { label: "Login blocked", tone: "text-danger" },
};

type Action = "mark_paid" | "extend" | "change_plan" | "comp" | null;

export function BillingTab({
  detail,
  role,
}: {
  detail: SerialisedTenantDetail;
  role: PlatformRole;
}) {
  const router = useRouter();
  const { tenant, billing } = detail;
  const [action, setAction] = useState<Action>(null);
  const canEdit = role === "PLATFORM_OWNER";

  // Local form state for the fields each action needs. Kept here rather than
  // inside the dialog so the values survive a validation failure.
  const [paidUntil, setPaidUntil] = useState(
    tenant.paidUntil ? tenant.paidUntil.slice(0, 10) : new Date().toISOString().slice(0, 10)
  );
  const [days, setDays] = useState(30);
  const [plan, setPlan] = useState(tenant.plan);
  const [seats, setSeats] = useState(tenant.seats);

  async function submit(reason: string) {
    const body: Record<string, unknown> = { action, reason };
    if (action === "mark_paid") body.paidUntil = new Date(`${paidUntil}T00:00:00.000Z`).toISOString();
    if (action === "extend") body.days = days;
    if (action === "change_plan") {
      body.plan = plan;
      body.seats = seats;
    }

    const res = await fetch(`/api/platform/tenants/${tenant.id}/billing`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(err?.error ?? "The billing change failed. Nothing was saved.");
    }
    router.refresh();
  }

  const rung = RUNG_COPY[billing.rung];

  const dialogCopy: Record<Exclude<Action, null>, { title: string; blast: string; confirm: string }> = {
    mark_paid: {
      title: "Mark as paid",
      blast: `Sets ${tenant.name}'s paid-until date to ${paidUntil} and restores full login. Calls are NOT affected — they were never stopped.`,
      confirm: "Mark paid",
    },
    extend: {
      title: "Extend paid-until",
      blast: `Extends ${tenant.name}'s access by ${days} day${days === 1 ? "" : "s"} from the later of today or their current paid-until date. Calls are NOT affected.`,
      confirm: "Extend",
    },
    change_plan: {
      title: "Change plan and seats",
      blast: `Changes ${tenant.name} from ${tenant.plan}/${tenant.seats} seats to ${plan}/${seats} seats. This changes what they are invoiced. It does not provision or remove any extension, and calls are NOT affected.`,
      confirm: "Change plan",
    },
    comp: {
      title: "Comp this tenant",
      blast: `Clears ${tenant.name}'s paid-until date entirely, so the billing ladder will never limit their access. Use for tenants who are not being charged. Calls are NOT affected.`,
      confirm: "Comp tenant",
    },
  };

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardContent className="space-y-3 p-5">
          <h2 className="text-[15px] font-semibold text-primary">Current billing</h2>

          <dl className="space-y-2 text-[13px]">
            <div className="flex justify-between border-b py-1.5 [border-color:rgb(var(--hairline))]">
              <dt className="text-tertiary">Plan</dt>
              <dd className="text-primary">{tenant.plan}</dd>
            </div>
            <div className="flex justify-between border-b py-1.5 [border-color:rgb(var(--hairline))]">
              <dt className="text-tertiary">Seats</dt>
              <dd className="text-primary">
                {detail.counts.extensions} used / {tenant.seats} sold
              </dd>
            </div>
            <div className="flex justify-between border-b py-1.5 [border-color:rgb(var(--hairline))]">
              <dt className="text-tertiary">Billing status</dt>
              <dd className="text-primary">{tenant.billingStatus}</dd>
            </div>
            <div className="flex justify-between border-b py-1.5 [border-color:rgb(var(--hairline))]">
              <dt className="text-tertiary">Paid until</dt>
              <dd className="text-primary" data-testid="paid-until">
                {tenant.paidUntil ? fmtDate(tenant.paidUntil) : "Not set (comped or trial)"}
              </dd>
            </div>
          </dl>

          {/* The ladder's current rung, stated explicitly rather than left
              for the operator to infer from a date. */}
          <div
            data-testid="enforcement-rung"
            data-rung={billing.rung}
            className="rounded-[var(--radius)] border p-3 [border-color:rgb(var(--hairline))]"
          >
            <p className="text-[12px] text-tertiary">Enforcement ladder</p>
            <p className={`text-[13px] font-medium ${rung.tone}`}>{rung.label}</p>
            {billing.graceDaysRemaining !== null && billing.rung === "warning" && (
              <p className="text-[12px] text-secondary">
                {billing.graceDaysRemaining} day{billing.graceDaysRemaining === 1 ? "" : "s"} of grace
                remaining before login is limited.
              </p>
            )}
            {billing.rung === "login_blocked" && (
              <p className="text-[12px] text-secondary">
                Agents cannot sign in. The tenant&apos;s own admin still can, and sees only a billing
                page.
              </p>
            )}
            <p className="mt-2 text-[11px] text-tertiary">{TELEPHONY_UNAFFECTED_NOTE}</p>
          </div>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <Card>
          <CardContent className="space-y-3 p-5">
            <h2 className="text-[15px] font-semibold text-primary">Manual actions</h2>
            {!canEdit ? (
              <p className="text-[12px] text-tertiary">
                Only a platform owner can change billing.
              </p>
            ) : (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="paid-until-input">Paid until</Label>
                    <Input
                      id="paid-until-input"
                      type="date"
                      value={paidUntil}
                      onChange={(e) => setPaidUntil(e.target.value)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="extend-days">Extend by (days)</Label>
                    <Input
                      id="extend-days"
                      type="number"
                      min={1}
                      value={days}
                      onChange={(e) => setDays(Number(e.target.value))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="plan-input">Plan</Label>
                    <Input id="plan-input" value={plan} onChange={(e) => setPlan(e.target.value)} />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="seats-input">Seats</Label>
                    <Input
                      id="seats-input"
                      type="number"
                      min={1}
                      value={seats}
                      onChange={(e) => setSeats(Number(e.target.value))}
                    />
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 pt-1" data-testid="billing-actions">
                  <Button size="sm" onClick={() => setAction("mark_paid")} data-testid="action-mark-paid">
                    Mark paid
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setAction("extend")}>
                    Extend
                  </Button>
                  <Button size="sm" variant="secondary" onClick={() => setAction("change_plan")}>
                    Change plan
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setAction("comp")}>
                    Comp
                  </Button>
                </div>
                <p className="text-[11px] text-tertiary">
                  Every action requires a reason and is recorded in the platform audit log.
                </p>
              </>
            )}
          </CardContent>
        </Card>

        {/* Documented, not coded. No gateway integration exists anywhere in
            this build — no webhook route, no billingRef writes. */}
        <Card>
          <CardContent className="space-y-2 p-5" data-testid="payment-automation-card">
            <h2 className="text-[13px] font-semibold text-primary">Payment automation: Phase 2</h2>
            <p className="text-[12px] text-secondary">
              Manual invoicing is the product today, and deliberately so. At this scale we are
              likely under the UAE VAT registration threshold, and B2B sales into India are
              self-assessed by the customer under reverse charge — so there is no compliance gain
              from automating yet.
            </p>
            <p className="text-[12px] text-secondary">
              Phase 2 is Paddle as merchant of record, conditional on confirming it onboards
              UAE-domiciled sellers. Stripe is the fallback (needs a UAE trade licence); Razorpay
              covers India; Hyperswitch self-hosted is the at-scale option.
            </p>
            <p className="text-[11px] text-tertiary">
              No payment gateway is connected. Nothing on this page talks to a processor.
            </p>
          </CardContent>
        </Card>
      </div>

      {action && (
        <ConfirmActionDialog
          open
          onClose={() => setAction(null)}
          title={dialogCopy[action].title}
          blastRadius={dialogCopy[action].blast}
          confirmLabel={dialogCopy[action].confirm}
          tone="default"
          onConfirm={submit}
        />
      )}
    </div>
  );
}
