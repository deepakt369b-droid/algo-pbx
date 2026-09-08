import { notFound } from "next/navigation";
import Link from "next/link";
import { requireAdminSession } from "@/lib/auth-guard";
import { UserVpnPanel } from "@/components/admin/user-vpn-panel";

export const dynamic = "force-dynamic";

// Tenant-admin user detail page — currently just the VPN tab (owner-page
// enchanted-sphinx plan, W3: "each user should have their own
// Tailscale/Headscale/OpenVPN/WireGuard setup page, only in the user admin
// page not agent page"). `requireAdminSession()` is the actual boundary
// keeping this out of the agent console — this page and every route under
// it are unreachable to an AGENT session regardless of what any nav shows.
export default async function AdminUserDetailPage({ params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) notFound();
  const { db } = guard;

  const user = await db.user.findUnique({
    where: { id: params.id },
    select: { id: true, email: true, name: true, role: true, disabled: true },
  });
  if (!user) notFound();

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <div>
        <Link href="/admin/users" className="text-[12px] text-secondary hover:text-primary">
          ← All users
        </Link>
      </div>

      <header>
        <h1 className="text-xl font-semibold tracking-tight text-primary">{user.name}</h1>
        <p className="text-[13px] text-secondary">
          {user.email} · {user.role}
          {user.disabled && <span className="ml-2 text-danger">(disabled)</span>}
        </p>
      </header>

      <UserVpnPanel userId={user.id} />
    </div>
  );
}
