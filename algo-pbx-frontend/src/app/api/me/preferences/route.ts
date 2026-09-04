import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSession } from "@/lib/auth-guard";

export const dynamic = "force-dynamic";

// Per-user UI preferences. Today: theme only. The client writes localStorage
// first (the no-flash script reads that), and syncs here so the choice
// survives a device change — a best-effort convenience, never load-bearing.
export async function GET() {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const user = await guard.db.user.findUnique({
    where: { id: guard.session.user.id },
    select: { themePreference: true },
  });
  return NextResponse.json({ themePreference: user?.themePreference ?? null });
}

const PatchSchema = z.object({
  themePreference: z.enum(["light", "dark", "system"]).nullable(),
});

export async function PATCH(request: NextRequest) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;
  const parsed = PatchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload" }, { status: 400 });
  }
  await guard.db.user.update({
    where: { id: guard.session.user.id },
    data: { themePreference: parsed.data.themePreference },
  });
  return NextResponse.json({ ok: true });
}
