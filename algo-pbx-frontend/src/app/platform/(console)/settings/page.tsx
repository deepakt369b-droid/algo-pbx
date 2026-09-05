import { notFound } from "next/navigation";
import { requirePlatformSetupSession } from "@/lib/platform-guard";
import { unsafeGlobalDb as db } from "@/lib/db";
import { getSetting } from "@/lib/settings/service";
import { probeTls } from "@/lib/domain/cert-probe";
import { readPkiStatus } from "@/lib/platform/pki-status";
import { TENANT_BASE_DOMAIN, WILDCARD_DNS_RECORD } from "@/lib/platform/domain-constants";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DependencyNotice } from "@/components/platform-shell/dependency-notice";
import { PlatformSettingsForm } from "@/components/platform/platform-settings-form";

export const dynamic = "force-dynamic";

function suffixOnly(value: string | null): string | null {
  if (!value) return null;
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}

export default async function PlatformSettingsPage() {
  const guard = await requirePlatformSetupSession();
  if ("response" in guard) notFound();
  const isOwner = guard.session.user.role === "PLATFORM_OWNER";

  const [cfToken, publicDomain, subnetFlag, pki, tenants] = await Promise.all([
    getSetting("CLOUDFLARE_API_TOKEN"),
    getSetting("VM_PUBLIC_DOMAIN"),
    getSetting("PROVISIONING_PER_TENANT_SUBNET_ENABLED"),
    readPkiStatus(),
    db.tenant.findMany({
      where: { status: { not: "OFFBOARDED" } },
      select: { id: true, slug: true },
      orderBy: { slug: "asc" },
    }),
  ]);

  // Probes the wildcard by asking for a hostname that can only be served by
  // it. A specific tenant's host would conflate "the wildcard cert works"
  // with "this tenant is set up".
  const wildcardProbe = await probeTls("caddy", `wildcard-probe.${TENANT_BASE_DOMAIN}`, 443, 5000).catch(
    () => ({ ok: false, error: "Probe failed." })
  );

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-primary">Platform settings</h1>
        <p className="text-[13px] text-secondary">
          Platform-global configuration. These apply across every tenant.
        </p>
      </header>

      {/* --- Domain & TLS ---------------------------------------------- */}
      <Card>
        <CardContent className="space-y-4 p-5">
          <div>
            <h2 className="text-[15px] font-semibold text-primary">Domain &amp; TLS</h2>
            <p className="text-[12px] text-secondary">
              Moved here from tenant admin. One token, one wildcard certificate, every tenant.
            </p>
          </div>

          <dl className="space-y-1.5 text-[13px]">
            <div className="flex justify-between border-b py-1.5 [border-color:rgb(var(--hairline))]">
              <dt className="text-tertiary">Tenant base domain</dt>
              <dd className="font-mono text-primary">{TENANT_BASE_DOMAIN}</dd>
            </div>
            <div className="flex justify-between border-b py-1.5 [border-color:rgb(var(--hairline))]">
              <dt className="text-tertiary">Required DNS record</dt>
              <dd className="font-mono text-primary">{WILDCARD_DNS_RECORD}</dd>
            </div>
            <div className="flex justify-between border-b py-1.5 [border-color:rgb(var(--hairline))]">
              <dt className="text-tertiary">Cloudflare API token</dt>
              <dd className="font-mono text-primary" data-testid="cf-token-suffix">
                {suffixOnly(cfToken ?? null) ?? "Not configured"}
              </dd>
            </div>
            <div className="flex justify-between border-b py-1.5 [border-color:rgb(var(--hairline))]">
              <dt className="text-tertiary">Wildcard certificate</dt>
              <dd data-testid="wildcard-cert-status">
                {wildcardProbe.ok ? (
                  <Badge tone="success">Serving</Badge>
                ) : (
                  <Badge tone="warning">Not issued</Badge>
                )}
              </dd>
            </div>
          </dl>

          {!wildcardProbe.ok && (
            <DependencyNotice
              feature={`Wildcard certificate for *.${TENANT_BASE_DOMAIN}`}
              blockedOn={`Not issued or not served. ${"error" in wildcardProbe ? wildcardProbe.error : ""}`}
              evidence={`Requires the one-time ${WILDCARD_DNS_RECORD} DNS record (grey-cloud) and a DNS-01 issuance. Provisioning only verifies resolution; it never creates per-tenant records.`}
            />
          )}

          <PlatformSettingsForm
            isOwner={isOwner}
            cloudflareConfigured={Boolean(cfToken)}
            publicDomain={publicDomain ?? ""}
            perTenantSubnetEnabled={subnetFlag === "true"}
            tenants={tenants}
          />
        </CardContent>
      </Card>

      {/* --- CA / PKI --------------------------------------------------- */}
      <Card>
        <CardContent className="space-y-3 p-5">
          <div>
            <h2 className="text-[15px] font-semibold text-primary">CA &amp; PKI</h2>
            <p className="text-[12px] text-secondary">
              Read-only inventory. This console holds no CA passphrase and offers no signing action —
              certificates are signed by hand until CA signing flow v2 ships.
            </p>
          </div>

          {!pki.available ? (
            <DependencyNotice
              feature="Certificate inventory"
              blockedOn={pki.unavailableReason ?? "The PKI directory is not readable from this container."}
              evidence="Inspect it on the OpenVPN host directly."
              tone="info"
            />
          ) : (
            <>
              <table className="w-full text-left text-[13px]" data-testid="pki-inventory">
                <thead className="border-b text-[11px] uppercase tracking-wide text-tertiary [border-color:rgb(var(--hairline))]">
                  <tr>
                    <th className="py-2 font-medium">Common name</th>
                    <th className="py-2 font-medium">Expires</th>
                    <th className="py-2 font-medium">Days left</th>
                  </tr>
                </thead>
                <tbody>
                  {pki.certs.map((c) => (
                    <tr key={c.commonName} className="border-b last:border-0 [border-color:rgb(var(--hairline))]">
                      <td className="py-2 font-mono text-primary">{c.commonName}</td>
                      <td className="py-2 text-secondary">{c.validTo?.slice(0, 10) ?? "Unreadable"}</td>
                      <td className="py-2">
                        {c.daysUntilExpiry === null ? (
                          <span className="text-tertiary">—</span>
                        ) : c.expired ? (
                          <Badge tone="danger">Expired</Badge>
                        ) : c.expiringSoon ? (
                          <Badge tone="warning">{c.daysUntilExpiry} days</Badge>
                        ) : (
                          <span className="text-secondary">{c.daysUntilExpiry}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {pki.certs.length === 0 && (
                    <tr>
                      <td colSpan={3} className="py-4 text-center text-tertiary">
                        No issued certificates found.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>

              <p className="text-[12px] text-secondary" data-testid="crl-status">
                CRL:{" "}
                {pki.crl.present
                  ? `last regenerated ${pki.crl.lastRegeneratedAt?.slice(0, 19).replace("T", " ")}Z`
                  : "never generated — revocation has not been exercised on this deployment."}
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
