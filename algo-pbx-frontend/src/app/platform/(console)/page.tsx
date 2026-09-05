import Link from "next/link";
import { AlertTriangle, Info, TriangleAlert } from "lucide-react";
import { loadOverview } from "@/lib/platform/overview";
import { runPlatformHealthChecks } from "@/lib/platform/health-checks";
import { TELEPHONY_UNAFFECTED_NOTE } from "@/lib/platform/blast-radius";
import type { CheckStatus } from "@/lib/health-check";
import type { AttentionSeverity } from "@/lib/platform/attention-queue";
import { Card, CardContent } from "@/components/ui/card";

export const dynamic = "force-dynamic";

// Console home. Three bands, in the order an operator actually needs them:
// what needs doing (attention queue), what the business looks like (tenants,
// seats, MRR), and whether the platform is standing up (health strip).
//
// Every figure here is computed from live rows by loadOverview(). Nothing is
// seeded or estimated, with the single deliberate exception of MRR — which
// is plan x seats with no payment processor behind it, and says so in the
// caption rather than in a doc nobody opens.

const DOT: Record<CheckStatus, string> = {
  ok: "bg-success",
  warn: "bg-warning",
  fail: "bg-danger",
  unknown: "bg-surface-hover",
};

const SEVERITY_STYLE: Record<AttentionSeverity, { icon: typeof AlertTriangle; className: string }> = {
  critical: { icon: AlertTriangle, className: "text-danger" },
  warning: { icon: TriangleAlert, className: "text-warning" },
  info: { icon: Info, className: "text-tertiary" },
};

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] uppercase tracking-wide text-tertiary">{label}</p>
      <p className="text-2xl font-semibold tabular-nums text-primary">{value}</p>
      {hint && <p className="text-[11px] text-tertiary">{hint}</p>}
    </div>
  );
}

export default async function PlatformOverviewPage() {
  // Health probes hit the network and can be slow; running them alongside
  // the DB work keeps the page's latency to the slower of the two rather
  // than their sum.
  const [overview, health] = await Promise.all([loadOverview(), runPlatformHealthChecks()]);
  const { statusCounts, seats, mrr, attention, attentionCounts } = overview;

  const aed = (n: number) => `AED ${n.toLocaleString("en-AE")}`;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-primary">Overview</h1>
        <p className="text-[13px] text-secondary">
          Every figure below is read live from the database.
        </p>
      </header>

      {/* --- Attention queue ------------------------------------------- */}
      <Card>
        <CardContent className="space-y-3 p-5">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="text-[15px] font-semibold text-primary">Needs attention</h2>
            {attention.length > 0 && (
              <p className="text-[11px] text-tertiary">
                {attentionCounts.critical} critical · {attentionCounts.warning} warning ·{" "}
                {attentionCounts.info} info
              </p>
            )}
          </div>

          {attention.length === 0 ? (
            <p className="py-2 text-[13px] text-tertiary" data-testid="attention-empty">
              Nothing needs attention. No failed deliveries, expiring grants, lapsing subscriptions,
              incomplete provisioning or downed tunnels.
            </p>
          ) : (
            <ul className="divide-y [border-color:rgb(var(--hairline))]" data-testid="attention-queue">
              {attention.map((item) => {
                const { icon: Icon, className } = SEVERITY_STYLE[item.severity];
                return (
                  <li key={item.id}>
                    <Link
                      href={item.href}
                      data-severity={item.severity}
                      className="-mx-2 flex items-start gap-3 rounded-[var(--radius)] px-2 py-2.5 transition-colors hover:bg-surface-hover"
                    >
                      <Icon size={15} className={`mt-0.5 shrink-0 ${className}`} aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13px] font-medium text-primary">{item.title}</span>
                        <span className="block text-[12px] text-secondary">{item.detail}</span>
                      </span>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* --- Business figures ------------------------------------------ */}
      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardContent className="space-y-4 p-5">
            <h2 className="text-[13px] font-semibold text-primary">Tenants</h2>
            <div className="grid grid-cols-2 gap-4" data-testid="tenant-status-counts">
              <Stat label="Trial" value={statusCounts.trial} />
              <Stat label="Active" value={statusCounts.active} />
              <Stat label="Past due" value={statusCounts.pastDue} />
              <Stat label="Suspended" value={statusCounts.suspended} />
            </div>
            <p className="text-[11px] text-tertiary">
              {statusCounts.total} total
              {statusCounts.offboarded > 0 && `, including ${statusCounts.offboarded} offboarded`}.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-4 p-5">
            <h2 className="text-[13px] font-semibold text-primary">Seats</h2>
            <div className="grid grid-cols-2 gap-4" data-testid="seat-summary">
              <Stat label="Sold" value={seats.sold} />
              <Stat label="Provisioned" value={seats.provisioned} hint="Extension rows" />
            </div>
            {seats.overAllocated.length > 0 ? (
              <p className="text-[11px] text-warning">
                Over allocation:{" "}
                {seats.overAllocated.map((o) => `${o.slug} (${o.provisioned}/${o.sold})`).join(", ")}.
              </p>
            ) : (
              <p className="text-[11px] text-tertiary">{seats.unused} sold seat(s) unused.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-4 p-5">
            <h2 className="text-[13px] font-semibold text-primary">MRR</h2>
            <Stat label="Monthly" value={aed(mrr.totalAed)} data-testid="mrr-total" />
            {/* The caption is not optional. A number on an owner dashboard
                that looks like MRR will be treated as MRR. */}
            <p className="text-[11px] text-tertiary" data-testid="mrr-caption">
              Bookkeeping estimate from plan × seats. No payment processor is connected — nothing
              here is reconciled against money received.
            </p>
            {mrr.unpricedPlans.length > 0 && (
              <p className="text-[11px] text-warning">
                No price configured for: {mrr.unpricedPlans.join(", ")} — counted as AED 0.
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-[11px] text-tertiary">{TELEPHONY_UNAFFECTED_NOTE}</p>

      {/* --- Platform health ------------------------------------------- */}
      <Card>
        <CardContent className="space-y-3 p-5">
          <h2 className="text-[15px] font-semibold text-primary">Platform health</h2>
          <ul className="grid gap-2 sm:grid-cols-2" data-testid="health-strip">
            {health.checks.map((check) => (
              <li
                key={check.id}
                data-check={check.id}
                data-status={check.status}
                className="flex items-start gap-2.5 rounded-[var(--radius)] border p-3 [border-color:rgb(var(--hairline))]"
              >
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${DOT[check.status]}`} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium text-primary">{check.label}</span>
                  <span className="block text-[12px] text-secondary">{check.detail}</span>
                  {check.hint && (
                    <span className="mt-0.5 block text-[11px] text-tertiary">{check.hint}</span>
                  )}
                  <span className="mt-1 block text-[11px] text-tertiary">
                    Checked {new Date(check.checkedAt).toLocaleTimeString()}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}
