import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import type { ApiKey } from "@prisma/client";

// Bearer-key auth for the machine-to-machine CRM API (/api/crm/**). An
// external CRM has no browser session and must not be handed one — mirrors
// the discriminated-union return shape of src/lib/auth-guard.ts's
// requireSession()/requireStaffSession() exactly so route code reads the
// same way regardless of which guard it's using:
//   const guard = await requireApiKey(request);
//   if ("response" in guard) return guard.response;
export async function requireApiKey(
  request: NextRequest
): Promise<{ apiKey: ApiKey } | { response: NextResponse }> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return { response: NextResponse.json({ error: "Missing Authorization: Bearer <key>" }, { status: 401 }) };
  }

  const keyHash = createHash("sha256").update(token).digest("hex");
  const apiKey = await db.apiKey.findUnique({ where: { keyHash } });

  if (!apiKey || apiKey.revokedAt) {
    return { response: NextResponse.json({ error: "Invalid or revoked API key" }, { status: 401 }) };
  }

  // Best-effort, not awaited by the caller — a slow lastUsedAt write should
  // never add latency to the actual request.
  void db.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);

  return { apiKey };
}
