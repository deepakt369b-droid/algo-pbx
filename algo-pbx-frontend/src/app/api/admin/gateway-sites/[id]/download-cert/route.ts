import { NextRequest, NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { requireAdminSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// GET /api/admin/gateway-sites/[id]/download-cert — Option A in the
// add-site wizard's deploy step (src/components/connectivity/
// add-site-wizard.tsx): the manual-fallback path, always offered alongside
// the automated push (Option B, push-vpn-config/route.ts) per the plan's
// explicit "never hide the manual path behind the automated one"
// requirement. Streams back the .ovpn generate-cert/route.ts already
// produced via the OpenVPN bridge's file-drop contract (bridge-watch.sh) —
// this route does not itself talk to the bridge, generate-cert must have
// already run and succeeded.
const CLIENTS_DIR = process.env.OPENVPN_CLIENTS_DIR || "/app/openvpn-clients";

// Same allowlist bridge-watch.sh and generate-cert/route.ts already
// enforce — defense in depth before this name is ever used to build a
// filesystem path, never trusted from the DB row alone.
const SAFE_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;

export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;
  const { db } = guard;

  const site = await db.gatewaySite.findUnique({ where: { id: params.id } });
  if (!site) return NextResponse.json({ error: "Site not found" }, { status: 404 });

  if (!SAFE_NAME_RE.test(site.name)) {
    return NextResponse.json({ error: `Site name "${site.name}" is not a safe filename.` }, { status: 400 });
  }

  let ovpnFile: Buffer;
  try {
    ovpnFile = await readFile(path.join(CLIENTS_DIR, `${site.name}.ovpn`));
  } catch {
    return NextResponse.json(
      { error: `No generated .ovpn found for "${site.name}" — run "Generate certificate" first.` },
      { status: 404 }
    );
  }

  // Real private key material — never cached, never logged, downloaded
  // once per click.
  return new NextResponse(new Uint8Array(ovpnFile), {
    status: 200,
    headers: {
      "Content-Type": "application/x-openvpn-profile",
      "Content-Disposition": `attachment; filename="${site.name}.ovpn"`,
      "Cache-Control": "no-store",
    },
  });
}
