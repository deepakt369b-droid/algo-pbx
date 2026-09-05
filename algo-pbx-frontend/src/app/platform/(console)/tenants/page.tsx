import Link from "next/link";
import { unsafeGlobalDb as db } from "@/lib/db";
import { evaluateBillingAccess } from "@/lib/billing/enforcement";
import { evaluateCompliance } from "@/lib/platform/compliance";
import { workspaceHost } from "@/lib/platform/domain-constants";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TenantFilters } from "@/components/platform/tenant-filters";

export const dynamic = "force-dynamic";

// The tenant list. Search and filtering are done in the URL (searchParams)
// rather than client state so a filtered view is linkable — an operator
// pasting "every past-due tenant" into a message is a real workflow, and it
// also means the acceptance test can navigate straight to a filtered state.

type Search = { q?: string; status?: string; billing?: string };

const STATUS_TONE: Record<string, "neutral" | "success" | "warning" | "danger"> = {
  TRIAL: "neutral",
  ACTIVE: "success",
  PAST_DUE: "warning",
  SUSPENDED: "danger",
  OFFBOARDED: "neutral",
};

function fmtDate(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "—";
}

export default async function TenantsPage({ searchParams }: { searchParams: Search }) {
  const q = (searchParams.q ?? "").trim();
  const status = searchParams.status ?? "";
  const billing = searchParams.billing ?? "";

  const tenants = await db.tenant.findMany({
    where: {
      ...(q
        ? {
            OR: [
              { slug: { contains: q, mode: "insensitive" as const } },
              { name: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
      ...(status ? { status: status as "TRIAL" | "ACTIVE" | "SUSPENDED" | "OFFBOARDED" } : {}),
      ...(billing
        ? { billingStatus: billing as "TRIAL" | "ACTIVE" | "PAST_DUE" | "SUSPENDED" }
        : {}),
    },
    include: {
      gatewaySites: { select: { status: true, lastHandshakeAt: true } },
      _count: { select: { users: true, extensions: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  const compliance = new Map(tenants.map((t) => [t.id, evaluateCompliance(t)]));

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-primary">Tenants</h1>
          <p className="text-[13px] text-secondary">
            {tenants.length} tenant{tenants.length === 1 ? "" : "s"}
            {(q || status || billing) && " matching the current filter"}.
          </p>
        </div>
        <Link
          href="/platform/provisioning/new"
          className="rounded-[var(--radius)] bg-accent px-3 py-2 text-[13px] font-medium text-accent-fg hover:opacity-90"
        >
          New tenant
        </Link>
      </header>

      <TenantFilters q={q} status={status} billing={billing} />

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-left text-[13px]" data-testid="tenants-table">
            <thead className="border-b text-[11px] uppercase tracking-wide text-tertiary [border-color:rgb(var(--hairline))]">
              <tr>
                <th className="px-4 py-3 font-medium">Slug</th>
                <th className="px-4 py-3 font-medium">Name</th>
                <th className="px-4 py-3 font-medium">Plan</th>
                <th className="px-4 py-3 font-medium">Seats</th>
                <th className="px-4 py-3 font-medium">Billing</th>
                <th className="px-4 py-3 font-medium">Paid until</th>
                <th className="px-4 py-3 font-medium">Tunnel</th>
                <th className="px-4 py-3 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => {
                const access = evaluateBillingAccess(t);
                // "Tunnel" summarises every gateway this tenant owns. A
                // tenant with no gateway row at all is not "down" — nothing
                // has been provisioned yet, and saying "down" would send an
                // operator hunting a network fault that does not exist.
                const sites = t.gatewaySites;
                const tunnel =
                  sites.length === 0
                    ? { label: "No gateway", tone: "neutral" as const }
                    : sites.some((s) => s.status === "UP")
                      ? { label: "Up", tone: "success" as const }
                      : sites.every((s) => s.lastHandshakeAt === null)
                        ? { label: "Never connected", tone: "warning" as const }
                        : { label: "Down", tone: "danger" as const };
                const comp = compliance.get(t.id);

                return (
                  <tr
                    key={t.id}
                    data-testid="tenant-row"
                    data-slug={t.slug}
                    className="border-b transition-colors last:border-0 hover:bg-surface-hover [border-color:rgb(var(--hairline))]"
                  >
                    <td className="px-4 py-3">
                      <Link
                        href={`/platform/tenants/${t.id}`}
                        className="font-mono text-accent underline-offset-2 hover:underline"
                      >
                        {t.slug}
                      </Link>
                      <span className="block text-[11px] text-tertiary">{workspaceHost(t.slug)}</span>
                    </td>
                    <td className="px-4 py-3 text-primary">
                      {t.name}
                      {comp && !comp.complete && (
                        <span
                          title={comp.summary}
                          data-testid="compliance-warning"
                          className="ml-2 rounded-full bg-warning/15 px-1.5 py-0.5 text-[10px] font-medium text-warning"
                        >
                          {comp.missing.length} compliance
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-secondary">{t.plan}</td>
                    <td className="px-4 py-3 tabular-nums text-secondary">
                      {t._count.extensions}/{t.seats}
                    </td>
                    <td className="px-4 py-3">
                      <Badge tone={STATUS_TONE[t.billingStatus] ?? "neutral"}>
                        {t.billingStatus}
                      </Badge>
                      {access.rung !== "ok" && (
                        <span className="ml-1.5 text-[11px] text-tertiary">
                          {access.rung === "warning"
                            ? `${access.graceDaysRemaining}d grace`
                            : "login blocked"}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 tabular-nums text-secondary">{fmtDate(t.paidUntil)}</td>
                    <td className="px-4 py-3">
                      <Badge tone={tunnel.tone}>{tunnel.label}</Badge>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-tertiary">{fmtDate(t.createdAt)}</td>
                  </tr>
                );
              })}
              {tenants.length === 0 && (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-tertiary">
                    {q || status || billing
                      ? "No tenants match this filter."
                      : "No tenants yet. Use “New tenant” to run the provisioning wizard."}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
