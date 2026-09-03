import { NextRequest, NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth-guard";
import { db } from "@/lib/db";
import { cutoverToSite } from "@/lib/dinstar/site-cutover";

export const dynamic = "force-dynamic";

// POST /api/admin/gateway-sites/[id]/cutover — re-points the LIVE PBX call
// path (the SIP trunk's [dinstar-aor]/[dinstar-identify] contact, and
// transitively the SMS provider's base URL) at a site's OpenVPN tunnel IP.
// This is the single highest-stakes action in the whole OpenVPN/Headscale/
// connectivity feature — ADMIN-only, same guard level as the pre-existing
// /api/admin/dinstar/apply route this mirrors.
//
// MEANT TO BE INVOKED ONLY as one step of a live, human-supervised session
// (see the plan's "G2 — HUMAN GATE, LIVE, SUPERVISED" checklist:
// C:\Users\DK\.claude\plans\currently-we-need-a-nifty-lightning.md) — after
// the tunnel is already confirmed up (cert generated + pushed + a real
// handshake observed in the OpenVPN status log + the tunnel IP answers
// ping), never before. Deliberately NOT wired into any cron job, the
// connectivity-check poller, or any other automated trigger — the poller
// (Node F) only ever reads/detects connectivity state, it must never itself
// call this route to "fix" a stale/DOWN site by re-pointing the trunk
// unattended. A human decides when a cutover happens; this route only
// executes one once told to.
export async function POST(_request: NextRequest, { params }: { params: { id: string } }) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const site = await db.gatewaySite.findUnique({ where: { id: params.id } });
  if (!site) return NextResponse.json({ error: "Site not found." }, { status: 404 });

  const result = await cutoverToSite(
    { id: site.id, tunnelIp: site.tunnelIp, gatewayLanIp: site.gatewayLanIp },
    guard.session.user.id
  );

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  // ok:true only means "the settings write + provisioning attempt both ran
  // without throwing" — it does NOT mean the trunk re-point was confirmed
  // live (V1 security review: a naive caller checking only `ok`/200 could
  // mistake an unverified provisioning attempt for a successful cutover).
  // DINSTAR_LAN_IP has already been changed to the new tunnel IP either way
  // (see site-cutover.ts's own comment on why this isn't auto-rolled-back) —
  // a non-200 here means "go read result.provision, the setting DID change,
  // go verify/fix the trunk by hand," not "nothing happened."
  if (!result.provision?.verified) {
    return NextResponse.json(result, { status: 502 });
  }
  return NextResponse.json(result);
}
