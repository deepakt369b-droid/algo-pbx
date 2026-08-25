import { NextResponse } from "next/server";
import { getAmiClient } from "@/lib/ami-client";
import { requireStaffSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

export async function GET() {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const ami = getAmiClient();
  try {
    await ami.connect();
    return NextResponse.json({ connected: ami.isConnected });
  } catch (err) {
    return NextResponse.json(
      { connected: false, error: err instanceof Error ? err.message : "unknown error" },
      { status: 503 }
    );
  }
}
