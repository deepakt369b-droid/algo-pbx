// Plan §3: "No silent impersonation. While a support grant is active, the
// tenant UI shows a visible banner." This is that banner. It's a pure
// presentational component — data-fetching is
// src/lib/support-grant.ts's getActiveGrantForTenant(tenantId), a server
// function a tenant-facing layout calls and passes the result down.
//
// WIRED IN (2026-09-06, owner console build) at both intended points, now
// that wave 2a's `session.user.tenantId` exists:
//   - src/app/admin/layout.tsx — inside <AdminShell>, before {children}
//   - src/app/agent/layout.tsx — inside <AgentShell>, before <CrmCallLayer>
// Both call `getActiveGrantForTenant(session.user.tenantId)` and pass the
// result here. Rendering it in the layouts rather than per page is
// deliberate: a banner that can be omitted from one page is not a guarantee.
export interface SupportAccessBannerProps {
  grant: {
    reason: string;
    expiresAt: Date | string;
    platformUser: { name: string; email: string };
  } | null;
}

export function SupportAccessBanner({ grant }: SupportAccessBannerProps) {
  if (!grant) return null;

  const expiresAt = typeof grant.expiresAt === "string" ? new Date(grant.expiresAt) : grant.expiresAt;

  return (
    <div
      role="status"
      data-testid="support-access-banner"
      className="flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-200"
    >
      <span aria-hidden className="text-base">
        ⚠
      </span>
      <p>
        <span className="font-medium">Support access active</span> — {grant.platformUser.name} (
        {grant.platformUser.email}), expires{" "}
        {expiresAt.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}. Reason:{" "}
        <span className="italic">{grant.reason}</span>
      </p>
    </div>
  );
}
