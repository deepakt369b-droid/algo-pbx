import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth-guard";
import { requireSetting } from "@/lib/settings/service";
import { applyDomainConfig } from "@/lib/domain/caddyfile";

export const dynamic = "force-dynamic";

// POST /api/admin/settings/domain/apply — DEPRECATED, kept working.
//
// Domain & TLS moved to the platform console (approved plan §6: one
// Cloudflare token, one wildcard certificate, every tenant). The tenant-admin
// UI no longer offers this action, and the platform counterpart is
// POST /api/platform/settings/domain/apply.
//
// This route is deliberately NOT deleted. It is the mechanism that keeps
// production TLS working, it may be wired into a deploy script or an
// operator's muscle memory, and removing a working endpoint in the same
// change that moves its UI is how a domain renewal fails at 3am with nobody
// remembering why. It now delegates to the shared implementation so the two
// planes cannot drift, and never emits the tenant wildcard — that dangerous
// option is platform-only and requires its own confirmation.

export async function POST() {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  let domain: string;
  let token: string;
  try {
    domain = await requireSetting("VM_PUBLIC_DOMAIN");
    token = await requireSetting("CLOUDFLARE_API_TOKEN");
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Domain or token not configured." }, { status: 400 });
  }

  const result = await applyDomainConfig({ domain, token, includeTenantWildcard: false });
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  return NextResponse.json({ ok: true, message: result.message });
}
