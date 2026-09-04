// Plan §3: "No silent impersonation. While a support grant is active, the
// tenant UI shows a visible banner." This is that banner. It's a pure
// presentational component — data-fetching is
// src/lib/support-grant.ts's getActiveGrantForTenant(tenantId), a server
// function a tenant-facing layout calls and passes the result down.
//
// NOT WIRED IN YET, deliberately (out of this wave's file scope — touching
// tenant-side layout files risks colliding with the concurrent wave-2a
// worktree's own changes to how those layouts get their scoped session).
// Wire it into, in a later wave:
//   - src/app/admin/layout.tsx — right after the `<AdminShell ...>` open,
//     e.g. `<AdminShell ...>{banner}<SupportAccessBanner grant={...} />{children}</AdminShell>`
//   - src/app/agent/layout.tsx — same spot, before `<CrmCallLayer>`.
// Both already exist as server components with access to the session; the
// missing piece a later wave adds is calling
// `getActiveGrantForTenant(session.user.tenantId)` there once wave 2a's
// tenant-on-session field lands, and passing the result to this component.
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
    <div className="flex items-center gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-200">
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
