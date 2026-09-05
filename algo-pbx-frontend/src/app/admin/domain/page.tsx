import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { unsafeGlobalDb as db } from "@/lib/db";
import { workspaceUrl, workspaceHost } from "@/lib/platform/domain-constants";

export const dynamic = "force-dynamic";

// "Your workspace URL" — the tenant-facing remnant of Domain & TLS.
//
// This page used to be a guided Connect-Domain flow: public domain field,
// Cloudflare API token field, and an action that regenerated the Caddyfile
// and recreated the reverse proxy. All three moved to the platform owner
// console (approved plan §6), because in a multi-tenant product they are not
// a tenant's to hold:
//
//   - There is ONE Cloudflare token, and it can rewrite DNS for every
//     tenant's workspace. A tenant admin holding it is a cross-tenant
//     capability wearing a settings field.
//   - There is ONE wildcard certificate covering every workspace, so there is
//     nothing per-tenant left to connect.
//   - The Connect action recreates the shared reverse proxy. One tenant
//     should not be able to restart everyone's TLS termination.
//
// The page is kept rather than deleted so an existing bookmark or nav link
// lands somewhere that explains itself, instead of a 404 that reads like a
// bug. What a tenant admin actually needs from here — where their workspace
// lives — is still answered.

export default async function DomainPage() {
  const session = await auth();
  if (session?.user.role !== "ADMIN" && session?.user.role !== "SUPERVISOR") {
    redirect("/agent");
  }

  const tenant = await db.tenant.findUnique({
    where: { id: session.user.tenantId },
    select: { slug: true, name: true },
  });
  if (!tenant) redirect("/admin");

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-primary">Your workspace URL</h1>
        <p className="text-[13px] text-secondary">
          Domain and TLS are managed by Algo PBX across every workspace.
        </p>
      </header>

      <div className="rounded-[var(--radius-lg)] border bg-surface p-5 [border-color:rgb(var(--hairline))]">
        <p className="text-[11px] uppercase tracking-wide text-tertiary">{tenant.name}</p>
        <a
          href={workspaceUrl(tenant.slug)}
          className="mt-1 block break-all font-mono text-[15px] text-accent underline-offset-2 hover:underline"
        >
          {workspaceHost(tenant.slug)}
        </a>
        <p className="mt-3 text-[12px] text-secondary">
          This address is covered by a wildcard certificate that Algo PBX renews automatically.
          There is nothing to configure, and no certificate for you to manage.
        </p>
        <p className="mt-2 text-[12px] text-tertiary">
          Need a custom domain of your own? Contact Algo PBX — it is an owner-side change.
        </p>
      </div>
    </div>
  );
}
