// Pure decision logic shared by the "add user/extension" Human|AI chooser
// (src/app/admin/users/page.tsx) and this directory's own list/editor
// pages. Kept dependency-free of React/fetch so it's unit-testable without
// mounting a component — this codebase has no @testing-library/react or
// jsdom test environment configured (vitest.config.ts runs `environment:
// "node"`), so these two decisions are extracted into plain functions
// instead of only existing inline inside JSX conditionals, the same
// "extract the pure decision" convention as src/lib/tenancy/scope-rules.ts.
import { planHasFeature } from "@/lib/platform/plan-catalog";
import type { SeatUsage } from "@/lib/ai/types";

/** Whether the tenant's plan unlocks the Human|AI chooser and the
 * /admin/ai-agents pages at all. Delegates entirely to the existing
 * `planHasFeature` — this function exists only so callers don't each
 * repeat the `"aiAgents"` feature-flag string. */
export function canOfferAiAgentOption(plan: string): boolean {
  return planHasFeature(plan, "aiAgents");
}

/** Whether a seat meter should block a new-extension submission (HUMAN or
 * AI — both consume the same seat pool per contracts.md's `SeatUsage`).
 * `seatsTotal <= 0` also counts as full: an unset/zero seat allocation
 * should never read as "unlimited". */
export function isSeatMeterFull(usage: Pick<SeatUsage, "seatsUsed" | "seatsTotal">): boolean {
  return usage.seatsTotal <= 0 || usage.seatsUsed >= usage.seatsTotal;
}
