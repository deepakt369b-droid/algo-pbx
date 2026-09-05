import { notFound } from "next/navigation";
import { requirePlatformSetupSession } from "@/lib/platform-guard";
import { RESERVED_TENANT_SLUGS } from "@/lib/tenant/slug";
import { TENANT_BASE_DOMAIN } from "@/lib/platform/domain-constants";
import { NewTenantForm } from "@/components/platform/new-tenant-form";

export const dynamic = "force-dynamic";

export default async function NewTenantPage() {
  const guard = await requirePlatformSetupSession();
  if ("response" in guard) notFound();

  if (guard.session.user.role !== "PLATFORM_OWNER") {
    return (
      <div className="mx-auto max-w-2xl">
        <p className="text-[13px] text-secondary">
          Only a platform owner can create tenants.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-primary">New tenant</h1>
        <p className="text-[13px] text-secondary">
          Creates the tenant and starts its provisioning run. The certificate step is a deliberate
          human gate — the wizard will pause there.
        </p>
      </header>

      <NewTenantForm baseDomain={TENANT_BASE_DOMAIN} reserved={[...RESERVED_TENANT_SLUGS]} />
    </div>
  );
}
