import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  PROVISIONING_STEPS,
  type ProvisioningState,
  type AdvanceVerdict,
} from "@/lib/platform/provisioning-machine";

// Read-only summary shown before the editable wizard (W2: "The provisioning
// is only opening the detail edit page while we come to the overview page" —
// clicking a run used to drop straight into ProvisioningWizard with no
// read-only summary of progress/prereqs/blockers first).
//
// Purely presentational — every input (progress, verdict, step list) is
// already computed by the page the same way it always was for the wizard;
// this just renders it before handing off to an explicit "Open edit wizard"
// action instead of always rendering the wizard.
export function ProvisioningOverview({
  tenantId,
  tenantName,
  tenantSlug,
  completed,
  lastError,
  verdict,
  progress,
}: {
  tenantId: string;
  tenantName: string;
  tenantSlug: string;
  completed: string[];
  lastError: { step: string; message: string } | null;
  verdict: AdvanceVerdict;
  progress: { completed: number; total: number };
}) {
  const done = new Set(completed);
  const pct = progress.total === 0 ? 0 : Math.round((progress.completed / progress.total) * 100);

  return (
    <div className="flex flex-col gap-5" data-testid="provisioning-overview">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-primary">
          Provisioning {tenantName}
        </h1>
        <p className="text-[13px] text-secondary">
          <span className="font-mono">{tenantSlug}</span> · {progress.completed} of{" "}
          {progress.total} steps complete
        </p>
      </header>

      <Card>
        <CardContent className="space-y-3 p-5">
          <div className="flex items-center justify-between text-[12px] text-secondary">
            <span>Progress</span>
            <span>{pct}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-surface-hover">
            <div
              className="h-full rounded-full bg-accent transition-[width]"
              style={{ width: `${pct}%` }}
            />
          </div>

          {"done" in verdict && verdict.done ? (
            <Badge tone="success">Provisioning complete</Badge>
          ) : "blocked" in verdict && verdict.blocked ? (
            <div
              data-testid="provisioning-blocker"
              className="rounded-[var(--radius)] border border-warning/30 bg-warning/10 p-3 text-[13px] text-warning"
            >
              <p className="font-medium">Blocked on: {verdict.step.label}</p>
              <p className="mt-1 text-[12px]">{verdict.reason}</p>
            </div>
          ) : verdict.ok ? (
            <p className="text-[13px] text-secondary">
              Next step: <span className="font-medium text-primary">{verdict.step.label}</span>
              {verdict.step.gate === "human" && (
                <span className="ml-1.5 text-[11px] text-tertiary">(human gate)</span>
              )}
            </p>
          ) : null}

          {lastError && (
            <div
              data-testid="provisioning-last-error"
              className="rounded-[var(--radius)] border border-danger/30 bg-danger/10 p-3 text-[13px] text-danger"
            >
              <p className="font-medium">Last error on: {lastError.step}</p>
              <p className="mt-1 text-[12px]">{lastError.message}</p>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5">
          <h2 className="mb-3 text-[15px] font-semibold text-primary">Steps</h2>
          <ol className="space-y-2">
            {PROVISIONING_STEPS.map((step, i) => {
              const isDone = done.has(step.id);
              const isNext = !isDone && "step" in verdict && verdict.step.id === step.id;
              return (
                <li
                  key={step.id}
                  className="flex items-start gap-3 rounded-[var(--radius)] border p-3 [border-color:rgb(var(--hairline))]"
                >
                  <Badge tone={isDone ? "success" : isNext ? "warning" : "neutral"}>
                    {isDone ? "Done" : isNext ? "Next" : `${i + 1}`}
                  </Badge>
                  <div className="min-w-0">
                    <p className="text-[13px] font-medium text-primary">{step.label}</p>
                    <p className="text-[12px] text-secondary">{step.description}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3">
        <Link
          href={`/platform/provisioning/${tenantId}?mode=edit`}
          data-testid="enter-wizard"
          className="rounded-[var(--radius)] bg-accent px-3 py-2 text-[13px] font-medium text-accent-fg hover:opacity-90"
        >
          Open edit wizard
        </Link>
        <Link
          href="/platform/provisioning"
          className="text-[13px] text-secondary hover:text-primary"
        >
          Back to all runs
        </Link>
      </div>
    </div>
  );
}
