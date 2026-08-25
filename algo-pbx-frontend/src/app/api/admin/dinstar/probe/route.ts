import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdminSession } from "@/lib/auth-guard";
import { probeDinstarCredentials } from "@/lib/dinstar-discovery";

export const dynamic = "force-dynamic";

const Schema = z.object({
  host: z.string().min(1),
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

  const result = await probeDinstarCredentials(parsed.data.host, parsed.data.username, parsed.data.password);
  return NextResponse.json(result);
}
