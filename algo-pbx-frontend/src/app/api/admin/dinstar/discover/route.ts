import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminSession } from "@/lib/auth-guard";
import { discoverDinstarHosts } from "@/lib/dinstar-discovery";

export const dynamic = "force-dynamic";

const Schema = z.object({ cidr: z.string().regex(/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/) });

// POST /api/admin/dinstar/discover { cidr } — bounded subnet scan for the
// Dinstar setup wizard. assertScannableCidr (called inside
// discoverDinstarHosts) is the hard guardrail: only RFC1918 + CGNAT/
// Tailscale ranges, capped at a /24 — this route can never be pointed at
// the public internet, deliberately or by a typo.
export async function POST(request: NextRequest) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload — expected a CIDR like 192.168.1.0/24." }, { status: 400 });

  try {
    const hosts = await discoverDinstarHosts(parsed.data.cidr);
    return NextResponse.json({ hosts });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Scan failed." }, { status: 400 });
  }
}
