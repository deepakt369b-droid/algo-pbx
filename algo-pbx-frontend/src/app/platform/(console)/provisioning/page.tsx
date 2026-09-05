import Link from "next/link";
import { unsafeGlobalDb as db } from "@/lib/db";
import { parseProvisioningState } from "@/lib/platform/tenant-detail";
import { nextStep, isComplete, progress } from "@/lib/platform/provisioning-machine";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export const dynamic = "force-dynamic";

// Provisioning overview: every tenant with a run in progress, plus the
// entry point for a new one.
//
// Tenants with no recorded state at all are excluded rather than shown at
// "0 of 12". They predate the pipeline (tenant #1 does), and listing them as
// un-provisioned would create permanent phantom work in the queue.

export default async function ProvisioningPage() {
  const tenants = await db.tenant.findMany({
    where: { status: { not: "OFFBOARDED" } },
    select: { id: true, slug: true, name: true, provisioningState: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  const runs = tenants
    .map((t) => {
      const state = parseProvisioningState(t.provisioningState);
      return { ...t, state, next: nextStep(state), done: isComplete(state), prog: progress(state) };
    })
    .filter((r) => r.state.completed.length > 0);

  const active = runs.filter((r) => !r.done);
  const finished = runs.filter((r) => r.done);

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-primary">Provisioning</h1>
          <p className="text-[13px] text-secondary">
            {active.length} run{active.length === 1 ? "" : "s"} in progress.
          </p>
        </div>
        <Link
          href="/platform/provisioning/new"
          className="rounded-[var(--radius)] bg-accent px-3 py-2 text-[13px] font-medium text-accent-fg hover:opacity-90"
        >
          New tenant
        </Link>
      </header>

      <Card>
        <CardContent className="p-5">
          <h2 className="mb-3 text-[15px] font-semibold text-primary">In progress</h2>
          {active.length === 0 ? (
            <p className="text-[13px] text-tertiary">No provisioning runs in progress.</p>
          ) : (
            <ul className="space-y-2" data-testid="provisioning-runs">
              {active.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/platform/provisioning/${r.id}`}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius)] border p-3 hover:bg-surface-hover [border-color:rgb(var(--hairline))]"
                  >
                    <span>
                      <span className="font-mono text-[13px] text-primary">{r.slug}</span>
                      <span className="ml-2 text-[12px] text-secondary">{r.name}</span>
                      <span className="block text-[11px] text-tertiary">
                        Next: {r.next?.label ?? "—"}
                        {r.next?.gate === "human" && " (human gate)"}
                      </span>
                    </span>
                    <Badge tone="warning">
                      {r.prog.completed}/{r.prog.total}
                    </Badge>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {finished.length > 0 && (
        <Card>
          <CardContent className="p-5">
            <h2 className="mb-3 text-[15px] font-semibold text-primary">Completed</h2>
            <ul className="space-y-1.5">
              {finished.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 text-[13px]">
                  <Link href={`/platform/tenants/${r.id}`} className="font-mono text-accent hover:underline">
                    {r.slug}
                  </Link>
                  <Badge tone="success">Complete</Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
