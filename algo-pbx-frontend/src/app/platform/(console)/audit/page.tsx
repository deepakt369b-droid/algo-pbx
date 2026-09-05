import Link from "next/link";
import { unsafeGlobalDb as db } from "@/lib/db";
import { queryAuditPage } from "@/lib/platform/audit-query";
import { Card, CardContent } from "@/components/ui/card";
import { AuditFilters } from "@/components/platform/audit-filters";

export const dynamic = "force-dynamic";

// The audit centre. Compliance evidence, so readability is treated as a
// feature rather than a nicety: the actions most worth finding — a dialplan
// cut, an offboarding — are the ones someone will be looking for under
// pressure, months later, possibly in a dispute.
//
// Three things follow from that:
//   - Telephony-affecting rows are visually distinct. "Which actions ever
//     stopped a customer's calls" should be answerable by scrolling.
//   - The reason is shown in full, not truncated. A reason nobody can read is
//     a reason nobody wrote for any purpose.
//   - Actor and tenant are links. An audit row that names a tenant but makes
//     you go and find it has only half-answered the question.

type Search = {
  action?: string;
  actorId?: string;
  tenantId?: string;
  from?: string;
  to?: string;
  cursor?: string;
};

function fmt(d: Date): string {
  return d.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

export default async function AuditPage({ searchParams }: { searchParams: Search }) {
  const [{ rows, nextCursor, total }, actors, tenants, distinctActions] = await Promise.all([
    queryAuditPage(searchParams),
    db.platformUser.findMany({ select: { id: true, email: true }, orderBy: { email: "asc" } }),
    db.tenant.findMany({ select: { id: true, slug: true }, orderBy: { slug: "asc" } }),
    db.platformAuditLog.findMany({
      select: { action: true },
      distinct: ["action"],
      orderBy: { action: "asc" },
    }),
  ]);

  const exportQs = new URLSearchParams(
    Object.entries(searchParams).filter(([k, v]) => v && k !== "cursor") as [string, string][]
  ).toString();

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-primary">Audit center</h1>
          <p className="text-[13px] text-secondary">
            {total.toLocaleString()} recorded action{total === 1 ? "" : "s"} on the platform plane.
          </p>
        </div>
        <a
          href={`/api/platform/audit/export${exportQs ? `?${exportQs}` : ""}`}
          data-testid="audit-export"
          className="rounded-[var(--radius)] border px-3 py-2 text-[13px] font-medium text-primary hover:bg-surface-hover [border-color:rgb(var(--hairline))]"
        >
          Export CSV
        </a>
      </header>

      <AuditFilters
        actions={distinctActions.map((a) => a.action)}
        actors={actors}
        tenants={tenants}
        current={searchParams}
      />

      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-left text-[13px]" data-testid="audit-table">
            <thead className="border-b text-[11px] uppercase tracking-wide text-tertiary [border-color:rgb(var(--hairline))]">
              <tr>
                <th className="px-4 py-3 font-medium">When (UTC)</th>
                <th className="px-4 py-3 font-medium">Action</th>
                <th className="px-4 py-3 font-medium">Actor</th>
                <th className="px-4 py-3 font-medium">Tenant</th>
                <th className="px-4 py-3 font-medium">Reason</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                // Rendered distinctly because it is the one class of action
                // that caused a customer-visible outage.
                const telephony =
                  typeof r.metadata === "object" &&
                  r.metadata !== null &&
                  (r.metadata as Record<string, unknown>).telephonyAffected === true;

                return (
                  <tr
                    key={r.id}
                    data-testid="audit-row"
                    data-action={r.action}
                    data-telephony={telephony}
                    className={`border-b align-top last:border-0 [border-color:rgb(var(--hairline))] ${
                      telephony ? "bg-danger/5" : ""
                    }`}
                  >
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-[12px] text-tertiary">
                      {fmt(r.createdAt)}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`font-mono text-[12px] ${telephony ? "text-danger" : "text-primary"}`}>
                        {r.action}
                      </span>
                      {telephony && (
                        <span className="block text-[10px] font-medium uppercase tracking-wide text-danger">
                          Stopped calls
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {r.platformUserId ? (
                        <Link
                          href="/platform/users"
                          className="text-accent underline-offset-2 hover:underline"
                        >
                          {r.platformUserEmail}
                        </Link>
                      ) : (
                        <span className="text-tertiary">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {r.tenantId ? (
                        <Link
                          href={`/platform/tenants/${r.tenantId}`}
                          className="font-mono text-accent underline-offset-2 hover:underline"
                        >
                          {r.tenantSlug}
                        </Link>
                      ) : (
                        <span className="text-tertiary">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-secondary">
                      {r.reason ? (
                        <span className="italic">{r.reason}</span>
                      ) : (
                        <span className="text-tertiary">—</span>
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-10 text-center text-tertiary">
                    No audit entries match this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>

      {nextCursor && (
        <div>
          <Link
            href={`/platform/audit?${new URLSearchParams({ ...(searchParams as Record<string, string>), cursor: nextCursor }).toString()}`}
            className="text-[13px] text-accent underline-offset-2 hover:underline"
          >
            Load older entries
          </Link>
        </div>
      )}
    </div>
  );
}
