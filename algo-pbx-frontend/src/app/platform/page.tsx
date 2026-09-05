import { redirect } from "next/navigation";
import { requirePlatformSetupSession } from "@/lib/platform-guard";
import { unsafeGlobalDb as db } from "@/lib/db";

// Owner console home — tenant listing. Any live, TOTP-confirmed
// PlatformUser can see this list (id/slug/name/status/billingStatus are
// not "tenant call content" — no support grant needed just to see that a
// tenant exists, per plan §3's distinction between listing/admin-shaped
// actions and actually reading a tenant's data). Deliberately read-only
// here: tenant CREATE/provisioning is wave 7, blocked on the CA
// signing-flow v2 the plan names explicitly — not built in this file.
export default async function PlatformHomePage() {
  const guard = await requirePlatformSetupSession();
  if ("response" in guard) {
    redirect("/platform/login");
  }
  if (!guard.totpConfirmedAt || guard.mustChangePassword) {
    redirect("/platform/setup");
  }

  const tenants = await db.tenant.findMany({
    select: { id: true, slug: true, name: true, status: true, billingStatus: true, plan: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  return (
    <main className="min-h-screen bg-background p-8">
      <div className="mx-auto flex max-w-4xl flex-col gap-6">
        <header className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold text-primary">Algo PBX Platform</h1>
            <p className="text-sm text-secondary">
              Signed in as {guard.session.user.email} ({guard.session.user.role})
            </p>
          </div>
        </header>

        <section className="glass-card overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-border text-xs uppercase tracking-wide text-tertiary">
              <tr>
                <th className="px-4 py-3">Slug</th>
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Billing</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((tenant) => (
                <tr key={tenant.id} className="border-b border-border/50 last:border-0">
                  <td className="px-4 py-3 font-mono text-primary">{tenant.slug}</td>
                  <td className="px-4 py-3 text-primary">{tenant.name}</td>
                  <td className="px-4 py-3 text-secondary">{tenant.plan}</td>
                  <td className="px-4 py-3 text-secondary">{tenant.status}</td>
                  <td className="px-4 py-3 text-secondary">{tenant.billingStatus}</td>
                </tr>
              ))}
              {tenants.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-tertiary">
                    No tenants yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </section>
      </div>
    </main>
  );
}
