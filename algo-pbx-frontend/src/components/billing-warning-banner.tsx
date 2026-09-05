import type { UiAccessState } from "@/lib/billing/enforcement";

// Rung 1 of the enforcement ladder, rendered. At this rung the banner IS the
// enforcement — full access is retained, and nothing else happens for seven
// days.
//
// Two deliberate choices in the copy:
//   - It states plainly that calls are unaffected. A customer seeing a red
//     billing warning in a phone system reasonably fears their phones are
//     about to stop; leaving that fear unaddressed turns a payment reminder
//     into a support call, or worse, a churn decision.
//   - It says how long they have, in days. "Payment overdue" with no deadline
//     is easy to defer indefinitely; a countdown is actionable.

export function BillingWarningBanner({ access }: { access: UiAccessState | null }) {
  if (!access || access.rung !== "warning" || !access.bannerText) return null;

  return (
    <div
      role="status"
      data-testid="billing-warning-banner"
      data-grace-days={access.graceDaysRemaining ?? ""}
      className="flex items-center gap-3 border-b border-warning/30 bg-warning/10 px-4 py-2 text-sm text-warning"
    >
      <span aria-hidden className="text-base">
        !
      </span>
      <p>{access.bannerText}</p>
    </div>
  );
}
