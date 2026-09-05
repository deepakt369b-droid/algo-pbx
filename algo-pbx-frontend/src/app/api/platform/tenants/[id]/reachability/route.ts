import { NextRequest, NextResponse } from "next/server";
import { unsafeGlobalDb as db } from "@/lib/db";
import { requirePlatformSession } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { probeTls } from "@/lib/domain/cert-probe";
import { checkARecord } from "@/lib/domain/dns-checks";
import { workspaceHost } from "@/lib/platform/domain-constants";

export const dynamic = "force-dynamic";

// GET /api/platform/tenants/[id]/reachability — "is this tenant's workspace
// actually reachable?"
//
// Strictly read-only: it resolves DNS and completes a TLS handshake, and
// writes nothing. The plan's "test connection moves to the owner console"
// is a diagnostic, not a repair — creating a DNS record from here would
// bypass the deliberate one-time-wildcard design.
//
// DNS and TLS are reported separately because they fail for different reasons
// and have different fixes: a missing wildcard record is a one-time owner
// action, while a TLS failure with DNS resolving is a certificate problem.
// Collapsing them into one red dot would send an operator to the wrong place.
export const GET = withApiErrorHandler(async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const guard = await requirePlatformSession();
  if ("response" in guard) return guard.response;

  const tenant = await db.tenant.findUnique({
    where: { id: params.id },
    select: { slug: true },
  });
  if (!tenant) return NextResponse.json({ error: "Tenant not found" }, { status: 404 });

  const host = workspaceHost(tenant.slug);

  const [dns, tls] = await Promise.all([
    checkARecord(host).catch((err: unknown) => ({
      ok: false,
      detail: err instanceof Error ? err.message : "DNS lookup failed.",
    })),
    probeTls("caddy", host, 443, 5000).catch(() => ({ ok: false, error: "TLS probe failed." })),
  ]);

  const dnsOk = Boolean((dns as { ok?: boolean }).ok);
  const tlsOk = Boolean(tls.ok);

  return NextResponse.json({
    host,
    ok: dnsOk && tlsOk,
    dns: { ok: dnsOk },
    tls: { ok: tlsOk, validTo: "validTo" in tls ? tls.validTo : undefined },
    detail: !dnsOk
      ? `${host} does not resolve — check the one-time wildcard DNS record exists.`
      : !tlsOk
        ? `${host} resolves but TLS failed: ${"error" in tls ? tls.error : "unknown"}`
        : `${host} resolves and serves TLS.`,
  });
});
