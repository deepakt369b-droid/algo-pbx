import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminSession } from "@/lib/auth-guard";
import { requireSetting } from "@/lib/settings/service";
import { findZoneForDomain, upsertARecord, CloudflareError } from "@/lib/domain/cloudflare";

export const dynamic = "force-dynamic";

const Schema = z.object({ ip: z.string().min(1) });

// POST /api/admin/domain/a-record { ip } — the same DNS:Edit permission
// the token already grants for Caddy's DNS-01 challenge is sufficient to
// also write the A record, so this removes a manual Cloudflare-dashboard
// step entirely. Always writes grey-cloud (proxied:false) — see
// lib/domain/cloudflare.ts's upsertARecord for why that is not a caller
// choice. Caller supplies the target IP explicitly (rather than this
// route re-detecting it) so the wizard can point at either the VM's LAN
// address (local testing) or its public IP (production), matching
// whichever step of the checklist the operator is on.
export async function POST(request: Request) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Expected { ip: string }." }, { status: 400 });

  let domain: string;
  let token: string;
  try {
    domain = await requireSetting("VM_PUBLIC_DOMAIN");
    token = await requireSetting("CLOUDFLARE_API_TOKEN");
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Domain or token not configured." }, { status: 400 });
  }

  try {
    const zone = await findZoneForDomain(token, domain);
    await upsertARecord(token, zone.id, domain, parsed.data.ip);
  } catch (err) {
    const message = err instanceof CloudflareError || err instanceof Error ? err.message : "Failed to write the A record.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  return NextResponse.json({ ok: true, message: `A record for ${domain} now points at ${parsed.data.ip} (not proxied).` });
}
