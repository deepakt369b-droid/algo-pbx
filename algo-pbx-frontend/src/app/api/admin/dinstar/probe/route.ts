import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminSession } from "@/lib/auth-guard";
import { probeDinstarCredentials, assertProbeableHost } from "@/lib/dinstar-discovery";

export const dynamic = "force-dynamic";

const Schema = z.object({
  // Loop B4: bare IPv4 (optionally :port) only — no hostnames, no paths,
  // no query strings. `assertProbeableHost` also confirms the IP is in a
  // private/Tailscale range, matching the `discover` route's guardrail.
  host: z.string().min(1).max(64),
  username: z.string().min(1),
  password: z.string().min(1),
});

// POST /api/admin/dinstar/probe { host, username, password } — tries both
// known UC2000 auth styles and reports which one worked (or a clear 401
// if neither did) plus the live SIM-port inventory.
export async function POST(request: NextRequest) {
  const guard = await requireAdminSession();
  if ("response" in guard) return guard.response;

  const parsed = Schema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });

  let host: string;
  try {
    host = assertProbeableHost(parsed.data.host);
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Invalid host" }, { status: 400 });
  }

  const result = await probeDinstarCredentials(host, parsed.data.username, parsed.data.password);
  return NextResponse.json(result);
}
