import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth-guard";
import { requireSetting } from "@/lib/settings/service";
import { probeTls } from "@/lib/domain/cert-probe";

export const dynamic = "force-dynamic";

// GET /api/admin/domain/cert-status — replaces the old "go read
// `docker logs algo-caddy`" instruction with a real in-app answer to "did
// Caddy actually get a certificate". Probes Caddy directly over the
// internal algo-net bridge network (service name "caddy"), so this works
// regardless of whether the domain is publicly reachable yet — DNS-01
// issuance needs no inbound connection at all, and neither does this check.
export async function GET() {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  let domain: string;
  try {
    domain = await requireSetting("VM_PUBLIC_DOMAIN");
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Domain not configured." }, { status: 400 });
  }

  const internal = await probeTls("caddy", domain, 443, 6000);
  return NextResponse.json({ domain, internal });
}
