// Shared shape for every "list of live dependency checks + an overall
// status" endpoint in this app (/api/admin/system/health,
// /api/admin/domain/status) — one contract so the frontend's status-row
// rendering (STATUS_STYLE, the dot + label pattern) works unmodified
// against either.
export type CheckStatus = "ok" | "warn" | "fail" | "unknown";

export interface HealthCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  hint?: string;
  docsHref?: string;
  checkedAt: string;
}

export function overallStatus(checks: HealthCheck[]): CheckStatus {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  if (checks.some((c) => c.status === "unknown")) return "unknown";
  return "ok";
}
