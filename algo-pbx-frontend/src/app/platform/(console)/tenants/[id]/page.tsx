import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { loadTenantDetail } from "@/lib/platform/tenant-detail";
import { requirePlatformSetupSession } from "@/lib/platform-guard";
import { Badge } from "@/components/ui/badge";
import { TenantDetailTabs } from "@/components/platform/tenant-detail/tenant-detail-tabs";

export const dynamic = "force-dynamic";

// The heart of the console. A server component that loads everything once and
// hands plain data to the tab components — so the tabs stay presentational
// and the page has a single, auditable set of queries.
//
// The role is passed down because owner-only actions are ABSENT for a
// PLATFORM_SUPPORT operator, not merely disabled. A greyed-out "Cut dialplan"
// button still teaches someone that the button exists and invites them to ask
// for the permission; not rendering it is both a cleaner boundary and a
// smaller attack surface (the routes enforce it regardless).

export default async function TenantDetailPage({
  params,
  searchParams,
}: {
  params: { id: string };
  searchParams: { tab?: string };
}) {
  const guard = await requirePlatformSetupSession();
  if ("response" in guard) notFound();

  const detail = await loadTenantDetail(params.id);
  if (!detail) notFound();

  const { tenant, identity, billing, compliance } = detail;

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <div>
        <Link
          href="/platform/tenants"
          className="inline-flex items-center gap-1.5 text-[12px] text-secondary hover:text-primary"
        >
          <ArrowLeft size={13} /> All tenants
        </Link>
      </div>

      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight text-primary">
            {tenant.name}
            <span className="font-mono text-[13px] font-normal text-tertiary">{tenant.slug}</span>
          </h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-[13px] text-secondary">
            <a
              href={identity.workspaceUrl}
              target="_blank"
              rel="noreferrer"
              className="text-accent underline-offset-2 hover:underline"
            >
              {identity.workspaceHost}
            </a>
            {identity.usesCustomDomain && (
              <span className="text-[11px] text-tertiary">(custom domain — tenant #1)</span>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={tenant.status === "ACTIVE" ? "success" : tenant.status === "OFFBOARDED" ? "neutral" : "danger"}>
            {tenant.status}
          </Badge>
          {tenant.dialplanCutAt && (
            <Badge tone="danger" data-testid="dialplan-cut-badge">
              Dialplan cut
            </Badge>
          )}
          {billing.rung !== "ok" && (
            <Badge tone={billing.rung === "warning" ? "warning" : "danger"}>
              {billing.rung === "warning"
                ? `${billing.graceDaysRemaining}d grace`
                : "Login blocked"}
            </Badge>
          )}
        </div>
      </header>

      {/* Compliance follows the tenant everywhere until it is closed out —
          it must not be something an operator can forget by not opening a
          particular tab. */}
      {!compliance.complete && (
        <p
          data-testid="compliance-banner"
          className="rounded-[var(--radius)] border border-warning/30 bg-warning/10 p-3 text-[13px] text-warning"
        >
          {compliance.summary}
        </p>
      )}

      <TenantDetailTabs
        detail={JSON.parse(JSON.stringify(detail))}
        role={guard.session.user.role}
        initialTab={searchParams.tab}
      />
    </div>
  );
}
