import { NextRequest, NextResponse } from "next/server";
import { access } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { unsafeGlobalDb as db } from "@/lib/db";
import { requirePlatformOwner } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { recordPlatformAudit } from "@/lib/platform/audit";
import { getSetting } from "@/lib/settings/service";
import { checkARecord } from "@/lib/domain/dns-checks";
import { workspaceHost } from "@/lib/platform/domain-constants";
import { allocateSubnetIndex, certCn, gatewayTunnelIp } from "@/lib/platform/subnet";
import { parseProvisioningState } from "@/lib/platform/tenant-detail";
import { canAdvance, completeStep, failStep } from "@/lib/platform/provisioning-machine";

export const dynamic = "force-dynamic";

// POST /api/platform/tenants/[id]/provisioning/advance — run exactly ONE
// step of the pipeline.
//
// One step per request, deliberately. A "provision everything" button that
// fails on step 7 leaves the operator guessing what did and did not happen;
// stepping means the persisted state always matches reality, and a resumed
// run picks up precisely where it stopped.
//
// canAdvance() is the authority on whether a step may run — the same pure
// machine the wizard renders from, so what the UI shows disabled and what the
// server refuses cannot disagree.

const BodySchema = z.object({
  // Set when the operator confirms they have run the manual easyrsa command.
  confirmManualCert: z.boolean().optional(),
  gatewayLanIp: z.string().max(255).optional(),
});

const PKI_DIR = process.env.OPENVPN_PKI_DIR || "/app/openvpn-pki";

async function certExists(cn: string): Promise<boolean> {
  try {
    await access(path.join(PKI_DIR, "issued", `${cn}.crt`));
    return true;
  } catch {
    return false;
  }
}

export const POST = withApiErrorHandler(async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const guard = await requirePlatformOwner();
  if ("response" in guard) return guard.response;

  const body = BodySchema.safeParse(await req.json().catch(() => ({})));
  const input = body.success ? body.data : {};

  const tenant = await db.tenant.findUnique({
    where: { id: params.id },
    include: { gatewaySites: true },
  });
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  const state = parseProvisioningState(tenant.provisioningState);
  const site = tenant.gatewaySites[0] ?? null;
  const cn = certCn(tenant.slug);

  const prereqs = {
    tunnelHandshakeAt: site?.lastHandshakeAt ?? null,
    perTenantSubnetEnabled: (await getSetting("PROVISIONING_PER_TENANT_SUBNET_ENABLED")) === "true",
    certPresent: await certExists(cn),
  };

  const verdict = canAdvance(state, prereqs);
  if ("done" in verdict) {
    return NextResponse.json({ done: true, message: "Provisioning is complete." });
  }
  if (!verdict.ok) {
    // A blocked step is not an error — it is the machine working. Recorded
    // so "why did provisioning stall" is answerable from the audit log.
    await recordPlatformAudit({
      action: "provisioning.blocked",
      platformUserId: guard.session.user.id,
      tenantId: tenant.id,
      metadata: { step: verdict.step.id, reason: verdict.reason },
    });
    return NextResponse.json(
      { blocked: true, step: verdict.step, reason: verdict.reason },
      { status: 409 }
    );
  }

  const step = verdict.step;
  let detail = "";

  try {
    switch (step.id) {
      case "validate_slug":
      case "create_tenant":
        // Both already happened at POST /api/platform/tenants — the tenant
        // row could not exist otherwise. Marked complete rather than re-run.
        detail = "Already performed at tenant creation.";
        break;

      case "allocate_subnet": {
        if (tenant.tunnelSubnetIndex !== null) {
          detail = `Already allocated: index ${tenant.tunnelSubnetIndex}.`;
          break;
        }
        const used = (
          await db.tenant.findMany({
            where: { tunnelSubnetIndex: { not: null } },
            select: { tunnelSubnetIndex: true },
          })
        ).map((t) => t.tunnelSubnetIndex as number);
        const index = allocateSubnetIndex(used);
        await db.tenant.update({ where: { id: tenant.id }, data: { tunnelSubnetIndex: index } });
        detail = `Allocated index ${index} (10.8.${index}.0/24).`;
        break;
      }

      case "create_gateway_site": {
        if (site) {
          detail = `Gateway site ${site.name} already exists.`;
          break;
        }
        if (tenant.tunnelSubnetIndex === null) {
          throw new Error("No subnet index allocated — run the previous step first.");
        }
        const created = await db.gatewaySite.create({
          data: {
            tenantId: tenant.id,
            name: cn,
            // The LAN IP is a fact about the customer's network that only
            // they can supply. Recorded as unknown rather than guessed —
            // a wrong address here silently breaks the VPN push later.
            gatewayLanIp: input.gatewayLanIp?.trim() || "0.0.0.0",
            tunnelIp: gatewayTunnelIp(tenant.tunnelSubnetIndex),
            transport: "OPENVPN",
          },
        });
        detail = `Created ${created.name}.${input.gatewayLanIp ? "" : " LAN IP not yet known — set it before pushing VPN config."}`;
        break;
      }

      case "allocate_subdomain": {
        // VERIFY ONLY. The one-time wildcard record is an owner action taken
        // once; provisioning never creates per-tenant DNS.
        const host = workspaceHost(tenant.slug);
        const dns = await checkARecord(host).catch(() => ({ ok: false }));
        if (!(dns as { ok?: boolean }).ok) {
          throw new Error(
            `${host} does not resolve. This is expected to be covered by the one-time wildcard DNS record — check that record exists rather than creating a per-tenant one.`
          );
        }
        detail = `${host} resolves.`;
        break;
      }

      case "compliance_checklist":
        // Recorded through its own endpoint; this step just acknowledges the
        // operator has been shown the list. An incomplete checklist does not
        // block, by design.
        detail = "Checklist acknowledged. Outstanding items remain visible as a warning.";
        break;

      case "issue_cert":
        // Only reachable when certExists() is already true — canAdvance()
        // blocks otherwise. Nothing is signed here, ever.
        if (!input.confirmManualCert) {
          return NextResponse.json(
            { error: "Confirm you have run the manual signing command before advancing." },
            { status: 400 }
          );
        }
        detail = `Certificate ${cn}.crt found on the host.`;
        break;

      case "write_ccd":
      case "firewall_rules":
      case "generate_ovpn":
      case "telephony_namespace":
      case "invite_tenant_admin":
        // These need host-side effects this container cannot perform (or, for
        // telephony, wave 6). Recorded as acknowledged manual steps rather
        // than silently marked done as though we had performed them.
        detail = `Manual step acknowledged: ${step.description}`;
        break;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Step failed.";
    await db.tenant.update({
      where: { id: tenant.id },
      data: { provisioningState: failStep(state, step.id, message) as object },
    });
    return NextResponse.json({ error: message, step: step.id }, { status: 400 });
  }

  const next = completeStep(state, step.id);
  await db.tenant.update({
    where: { id: tenant.id },
    data: { provisioningState: next as object },
  });

  await recordPlatformAudit({
    action: "provisioning.step",
    platformUserId: guard.session.user.id,
    tenantId: tenant.id,
    metadata: { step: step.id, gate: step.gate, detail },
  });

  return NextResponse.json({ completed: step.id, detail, state: next });
});
