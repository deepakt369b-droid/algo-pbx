import { unsafeGlobalDb as db } from "@/lib/db";
import { requirePlatformSetupSession } from "@/lib/platform-guard";
import { notFound } from "next/navigation";
import { enabledOwnerCount } from "@/lib/platform/user-guardrails";
import { PlatformUsersTable } from "@/components/platform/platform-users-table";

export const dynamic = "force-dynamic";

export default async function PlatformUsersPage() {
  const guard = await requirePlatformSetupSession();
  if ("response" in guard) notFound();

  const users = await db.platformUser.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      disabled: true,
      disabledAt: true,
      lastLoginAt: true,
      totpConfirmedAt: true,
      mustChangePassword: true,
      createdAt: true,
    },
    orderBy: [{ disabled: "asc" }, { createdAt: "asc" }],
  });

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-primary">Platform users</h1>
        <p className="text-[13px] text-secondary">
          Accounts with access to this console. Every account requires TOTP — there is no path that
          skips it.
        </p>
      </header>

      <PlatformUsersTable
        users={users.map((u) => ({
          ...u,
          disabledAt: u.disabledAt?.toISOString() ?? null,
          lastLoginAt: u.lastLoginAt?.toISOString() ?? null,
          totpConfirmedAt: u.totpConfirmedAt?.toISOString() ?? null,
          createdAt: u.createdAt.toISOString(),
        }))}
        currentUserId={guard.session.user.id}
        currentRole={guard.session.user.role}
        enabledOwners={enabledOwnerCount(users)}
      />
    </div>
  );
}
