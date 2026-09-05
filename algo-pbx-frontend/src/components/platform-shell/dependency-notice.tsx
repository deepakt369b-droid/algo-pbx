import Link from "next/link";
import { AlertTriangle, Info } from "lucide-react";
import { cn } from "@/lib/utils";

// The honesty primitive.
//
// The console's standing rule is "no fake data, no dead buttons": where a
// backend piece is not built, the UI says so and shows the dependency status
// instead of pretending. This component is how it says so.
//
// The failure mode it prevents is subtle. A disabled button with no
// explanation, or a metric showing a clean green "0", both read as "working,
// nothing to report" — so an operator concludes recordings are being
// delivered when in fact no delivery worker exists. A zero that means "we
// never looked" must never render the same as a zero that means "we looked
// and there was nothing".
//
// So every use names three things: the capability, exactly what it is blocked
// on, and where that blocker is tracked.

export interface DependencyNoticeProps {
  /** What is not available, in the user's language ("Recording delivery"). */
  feature: string;
  /** The specific blocker — a named dependency, not "coming soon". */
  blockedOn: string;
  /** Where the blocker's state is tracked, so the claim is checkable. */
  evidence?: string;
  evidenceHref?: string;
  /** "info" for a deliberate design gate (the human cert step); "warning"
   * for something genuinely missing that an operator may be relying on. */
  tone?: "info" | "warning";
  className?: string;
  children?: React.ReactNode;
}

export function DependencyNotice({
  feature,
  blockedOn,
  evidence,
  evidenceHref,
  tone = "warning",
  className,
  children,
}: DependencyNoticeProps) {
  const Icon = tone === "info" ? Info : AlertTriangle;

  return (
    <div
      role="note"
      data-testid="dependency-notice"
      data-feature={feature}
      className={cn(
        "flex gap-3 rounded-[var(--radius)] border p-4 text-[13px]",
        tone === "warning"
          ? "border-warning/30 bg-warning/10 text-warning"
          : "border-hairline bg-surface-subtle text-secondary",
        className
      )}
    >
      <Icon size={16} className="mt-0.5 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-1">
        <p className="font-medium text-primary">{feature} is not available yet</p>
        <p>
          <span className="text-tertiary">Blocked on: </span>
          {blockedOn}
        </p>
        {evidence &&
          (evidenceHref ? (
            <p>
              <Link href={evidenceHref} className="text-accent underline underline-offset-2">
                {evidence}
              </Link>
            </p>
          ) : (
            <p className="text-tertiary">{evidence}</p>
          ))}
        {children && <div className="pt-1">{children}</div>}
      </div>
    </div>
  );
}

/**
 * A metric that has no measurement behind it.
 *
 * Renders "—" plus the reason, never "0". The distinction matters: a queue
 * depth of 0 from a running worker is good news; the same 0 from a worker
 * that does not exist is an absence of information, and showing them
 * identically is how an operator ends up trusting a number nobody computed.
 */
export function UnmeasuredStat({ label, reason }: { label: string; reason: string }) {
  return (
    <div className="space-y-0.5" data-testid="unmeasured-stat">
      <p className="text-[11px] uppercase tracking-wide text-tertiary">{label}</p>
      <p className="text-xl font-semibold text-tertiary" aria-label={`${label}: not measured`}>
        —
      </p>
      <p className="text-[11px] text-tertiary">{reason}</p>
    </div>
  );
}
