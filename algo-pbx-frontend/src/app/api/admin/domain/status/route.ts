import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth-guard";
import { getSetting } from "@/lib/settings/service";
import { verifyCloudflareToken, findZoneForDomain, CloudflareError } from "@/lib/domain/cloudflare";
import { checkNameservers } from "@/lib/domain/dns-checks";
import { probeTls } from "@/lib/domain/cert-probe";
import { type HealthCheck, overallStatus } from "@/lib/health-check";

export const dynamic = "force-dynamic";

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

// GET /api/admin/domain/status — the aggregated checklist behind
// /admin/domain, one row per step, same HealthCheck[] shape
// /api/admin/system/health already uses so the frontend's status-row
// rendering works unmodified against either. Each check is independent
// and best-effort: a later step (cert) can still report even if an
// earlier one (nameservers) hasn't resolved yet, since propagation delay
// is real and the operator needs to see partial progress, not an
// all-or-nothing gate.
export async function GET() {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const now = () => new Date().toISOString();
  const checks: HealthCheck[] = [];

  const domain = await getSetting("VM_PUBLIC_DOMAIN");
  const token = await getSetting("CLOUDFLARE_API_TOKEN");
  const domainConfigured = Boolean(domain) && !IPV4_RE.test(domain ?? "");

  checks.push({
    id: "domain",
    label: "Domain",
    status: domainConfigured ? "ok" : "fail",
    detail: domainConfigured ? domain! : domain ? `"${domain}" is an IP address, not a domain name.` : "No domain saved yet.",
    hint: domainConfigured ? undefined : "Enter and save a real domain name above.",
    checkedAt: now(),
  });

  if (domainConfigured) {
    const ns = await checkNameservers(domain!);
    checks.push({
      id: "nameservers",
      label: "Nameservers",
      status: ns.onCloudflare ? "ok" : "warn",
      detail: ns.nameservers.length ? ns.nameservers.join(", ") : "Not resolving yet.",
      hint: ns.onCloudflare ? undefined : "Point this domain's nameservers at Cloudflare in your registrar's dashboard, then wait for propagation.",
      checkedAt: now(),
    });
  }

  if (domainConfigured && token) {
    try {
      await verifyCloudflareToken(token);
      const zone = await findZoneForDomain(token, domain!);
      checks.push({
        id: "cloudflare-token",
        label: "Cloudflare token",
        status: "ok",
        detail: `Valid, zone "${zone.name}" covers ${domain}.`,
        checkedAt: now(),
      });
    } catch (err) {
      checks.push({
        id: "cloudflare-token",
        label: "Cloudflare token",
        status: "fail",
        detail: err instanceof CloudflareError || err instanceof Error ? err.message : "Token check failed.",
        hint: "Create a token scoped Zone:DNS:Edit + Zone:Zone:Read for this domain's zone and paste it above.",
        checkedAt: now(),
      });
    }
  } else if (domainConfigured) {
    checks.push({
      id: "cloudflare-token",
      label: "Cloudflare token",
      status: "warn",
      detail: "No token saved yet.",
      hint: "Create a token scoped Zone:DNS:Edit + Zone:Zone:Read for this domain's zone and paste it above.",
      checkedAt: now(),
    });
  }

  if (domainConfigured) {
    const cert = await probeTls("caddy", domain!, 443, 6000);
    checks.push({
      id: "cert",
      label: "Certificate",
      status: cert.ok ? "ok" : "warn",
      detail: cert.ok
        ? `Issued by ${cert.issuer ?? "unknown issuer"}, valid until ${cert.validTo ?? "unknown"}.`
        : (cert.error ?? "Caddy has not issued a certificate for this domain yet."),
      hint: cert.ok
        ? undefined
        : "Click Connect domain below, then check back in a minute or two — Caddy requests the certificate on demand.",
      checkedAt: now(),
    });
  }

  return NextResponse.json({ checks, overall: overallStatus(checks) });
}
