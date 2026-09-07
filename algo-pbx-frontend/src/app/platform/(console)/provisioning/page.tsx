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
// Tenants with no recorded state at all used to be excluded entirely rather
// than shown at "0 of 12" (plan §1: "Provisioning hides tenants with no
// provisioningState"). That silently dropped them from the one page whose
// job is to say what still needs doing — a tenant created outside the wizard,
// or one whose very first step never wrote any state, would never appear
// here at all. They are now listed under "Not started" instead: distinct
// from "In progress" (has SOME completed steps) and from "Completed", so a
// null state reads as "hasn't begun" rather than as another flavour of "0 of
// 12" that would be indistinguishable from a run stuck on step one.

export default async function ProvisioningPage() {
  const tenants = await db.tenant.findMany({
    where: { status: { not: "OFFBOARDED" } },
    select: { id: true, slug: true, name: true, provisioningState: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  const runs = tenants.map((t) => {
    const state = parseProvisioningState(t.provisioningState);
    return { ...t, state, next: nextStep(state), done: isComplete(state), prog: progress(state) };
  });

  const notStarted = runs.filter((r) => r.state.completed.length === 0);
  const active = runs.filter((r) => r.state.completed.length > 0 && !r.done);
  const finished = runs.filter((r) => r.state.completed.length > 0 && r.done);

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

      {notStarted.length > 0 && (
        <Card>
          <CardContent className="p-5">
            <h2 className="mb-3 text-[15px] font-semibold text-primary">Not started</h2>
            <p className="mb-3 text-[13px] text-tertiary">
              No provisioning step has ever run for these tenants — they predate the pipeline, were
              created outside it, or the run never began.
            </p>
            <ul className="space-y-1.5" data-testid="provisioning-not-started">
              {notStarted.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 text-[13px]">
                  <span>
                    <span className="font-mono text-primary">{r.slug}</span>
                    <span className="ml-2 text-secondary">{r.name}</span>
                  </span>
                  <Badge tone="neutral">Not started</Badge>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

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
