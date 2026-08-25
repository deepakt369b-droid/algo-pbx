import { createHmac, randomUUID } from "crypto";
import { NextResponse } from "next/server";
import { requireSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// GET /api/me/turn-credentials — mints short-lived coturn REST ephemeral
// credentials (RFC 5766 / draft-uberti-behave-turn-rest) for the calling
// agent's own browser to use as an ICE TURN server.
//
// Why this route exists at all: coturn is deployed (docker-compose.yml's
// `coturn` service) with --use-auth-secret, which means it does NOT accept
// a static username/password — every client must present a
// `<expiry-unix-ts>:<label>` username whose password is
// HMAC-SHA1(COTURN_AUTH_SECRET, username), base64-encoded. Before this
// route existed, no code anywhere read NEXT_PUBLIC_TURN_SERVER or
// constructed such a credential — src/contexts/sip-context.tsx passed no
// `iceServers` at all, so the browser only ever gathered host candidates.
// That works by accident today only because Asterisk sits on a public IP
// and can learn a peer-reflexive address from the first inbound packet —
// which fails outright for an agent behind symmetric NAT (common on
// Indian carrier-grade NAT) or a firewall blocking outbound UDP to
// arbitrary high ports. This route is what makes the TURN relay actually
// reachable as a fallback.
//
// The credential expires in 2 hours and is scoped to nothing but TURN
// relay allocation — it grants no access to anything else in the system,
// so minting it per-agent-session (rather than one shared long-lived
// secret shipped to every browser) costs nothing and avoids handing out
// COTURN_AUTH_SECRET itself to a browser.
export async function GET() {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;

  const secret = process.env.COTURN_AUTH_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "TURN is not configured on this server." }, { status: 503 });
  }

  const ttlSeconds = 2 * 60 * 60; // 2 hours
  const expiry = Math.floor(Date.now() / 1000) + ttlSeconds;
  // Label with the session user id (not the SIP extension) — this
  // credential authorizes a TURN allocation, not a SIP identity, so it
  // doesn't need to match the extension number; a stable, non-guessable
  // label is enough for coturn's own audit logs.
  const username = `${expiry}:${guard.session.user.id ?? randomUUID()}`;
  const credential = createHmac("sha1", secret).update(username).digest("base64");

  const domain = process.env.VM_PUBLIC_DOMAIN;
  if (!domain) {
    return NextResponse.json({ error: "TURN domain is not configured on this server." }, { status: 503 });
  }

  return NextResponse.json({
    username,
    credential,
    urls: [
      `stun:${domain}:3478`,
      `turn:${domain}:3478?transport=udp`,
      `turn:${domain}:3478?transport=tcp`,
      `turns:${domain}:5349?transport=tcp`,
    ],
    ttl: ttlSeconds,
  });
}
