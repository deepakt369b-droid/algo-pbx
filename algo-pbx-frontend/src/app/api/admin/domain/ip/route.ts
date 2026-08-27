import { NextResponse } from "next/server";
import { requireAdminSession } from "@/lib/auth-guard";
import { detectPublicIp } from "@/lib/domain/public-ip";

export const dynamic = "force-dynamic";

// GET /api/admin/domain/ip — the A-record step's "point it at this IP"
// display. Note this is the VM's *outbound* public IP, which is only the
// right A-record target once the VM has real inbound reachability; while
// testing on a private LAN (see LLM.md's live-VM networking notes) the
// operator points the A record at the VM's LAN address instead and this
// value is informational only.
export async function GET() {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const ip = await detectPublicIp();
  if (!ip) return NextResponse.json({ error: "Could not detect a public IP — outbound internet may be unavailable." }, { status: 502 });
  return NextResponse.json({ ip });
}
