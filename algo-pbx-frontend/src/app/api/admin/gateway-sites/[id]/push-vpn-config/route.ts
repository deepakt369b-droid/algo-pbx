import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { requireAdminSession } from "@/lib/auth-guard";
import { db } from "@/lib/db";
import { pushVpnConfig } from "@/lib/dinstar/vpn-push";

export const dynamic = "force-dynamic";

// POST /api/admin/gateway-sites/[id]/push-vpn-config — pushes the
// already-generated .ovpn (see generate-cert/route.ts, which must run
// first) to the real Dinstar gateway's admin UI. ADMIN-only: this writes
// live config to production telephony hardware. Returns pushVpnConfig()'s
// full per-step result (loggedIn/pushed/verifiedByReadback) so the wizard
// can show exactly what happened rather than a single boolean — never
// trust the underlying POST's 200 alone, per the task's explicit
// requirement.
const CLIENTS_DIR = process.env.OPENVPN_CLIENTS_DIR || "/app/openvpn-clients";

// Same allowlist generate-cert/route.ts, download-cert/route.ts, and
// bridge-watch.sh all independently re-validate against before using
// `site.name` in a filesystem path or (here) a multipart filename — V1
// security review caught this route as the one place in the set that was
// trusting the create-route's validation alone rather than re-checking.
// Currently unexploitable (name is immutable post-creation and Zod-
// enforced at creation), but this route shouldn't be the single point of
// trust for that guarantee.
const SAFE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const site = await db.gatewaySite.findUnique({ where: { id: params.id } });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  if (!SAFE_NAME_RE.test(site.name)) {
    return NextResponse.json({ error: `Site name "${site.name}" is not safe to use as a filename.` }, { status: 400 });
  }

  const ovpnPath = path.join(CLIENTS_DIR, `${site.name}.ovpn`);
  let ovpnFile: Buffer;
  try {
    ovpnFile = await readFile(ovpnPath);
  } catch {
    return NextResponse.json(
      { error: `No generated .ovpn found for "${site.name}" — run generate-cert first.` },
      { status: 400 }
    );
  }

  const result = await pushVpnConfig(site.id, site.gatewayLanIp, ovpnFile, `${site.name}.ovpn`, guard.session.user.id);

  return NextResponse.json(result, { status: result.verifiedByReadback ? 200 : 502 });
}
