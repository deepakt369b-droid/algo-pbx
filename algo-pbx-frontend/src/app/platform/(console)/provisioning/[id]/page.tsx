import { notFound } from "next/navigation";
import { access } from "node:fs/promises";
import path from "node:path";
import { requirePlatformSetupSession } from "@/lib/platform-guard";
import { loadTenantDetail } from "@/lib/platform/tenant-detail";
import { getSetting } from "@/lib/settings/service";
import { certCn } from "@/lib/platform/subnet";
import { canAdvance } from "@/lib/platform/provisioning-machine";
import { buildEasyRsaCommand } from "@/lib/platform/manual-cert-command";
import { ProvisioningWizard } from "@/components/platform/provisioning-wizard";

export const dynamic = "force-dynamic";

const PKI_DIR = process.env.OPENVPN_PKI_DIR || "/app/openvpn-pki";

async function certExists(cn: string): Promise<boolean> {
  try {
    await access(path.join(PKI_DIR, "issued", `${cn}.crt`));
    return true;
  } catch {
    return false;
  }
}

export default async function ProvisioningRunPage({ params }: { params: { id: string } }) {
  const guard = await requirePlatformSetupSession();
  if ("response" in guard) notFound();

  const detail = await loadTenantDetail(params.id);
  if (!detail) notFound();

  const cn = certCn(detail.tenant.slug);
  const site = detail.tenant.gatewaySites[0] ?? null;

  const prereqs = {
    tunnelHandshakeAt: site?.lastHandshakeAt ?? null,
    perTenantSubnetEnabled: (await getSetting("PROVISIONING_PER_TENANT_SUBNET_ENABLED")) === "true",
    certPresent: await certExists(cn),
  };

  const verdict = canAdvance(detail.provisioning.state, prereqs);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-5">
      <header>
        <h1 className="text-xl font-semibold tracking-tight text-primary">
          Provisioning {detail.tenant.name}
        </h1>
        <p className="text-[13px] text-secondary">
          <span className="font-mono">{detail.tenant.slug}</span> ·{" "}
          {detail.provisioning.progress.completed} of {detail.provisioning.progress.total} steps
          complete
        </p>
      </header>

      <ProvisioningWizard
        tenantId={detail.tenant.id}
        completed={detail.provisioning.state.completed}
        lastError={detail.provisioning.state.lastError ?? null}
        verdict={JSON.parse(JSON.stringify(verdict))}
        certCommand={buildEasyRsaCommand(cn)}
        certPresent={prereqs.certPresent}
        isOwner={guard.session.user.role === "PLATFORM_OWNER"}
        gatewayLanIpKnown={Boolean(site && site.gatewayLanIp !== "0.0.0.0")}
      />
    </div>
  );
}
