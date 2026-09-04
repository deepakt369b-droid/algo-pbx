import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { unsafeGlobalDb } from "@/lib/db";
import { tenantDb, type TenantClient } from "@/lib/db-tenant";
import type { ApiKey } from "@prisma/client";

// Bearer-key auth for the machine-to-machine CRM API (/api/crm/**). An
// external CRM has no browser session and must not be handed one — mirrors
// the discriminated-union return shape of src/lib/auth-guard.ts's
// requireSession()/requireStaffSession() exactly so route code reads the
// same way regardless of which guard it's using:
//   const guard = await requireApiKey(request);
//   if ("response" in guard) return guard.response;
//
// Wave 2a multi-tenant migration (plan §2, "known bypasses" #2): ApiKey is
// now tenant-scoped. This guard now mirrors auth-guard.ts's three guards
// exactly — it returns `{ apiKey, db }` where `db` is a client already
// scoped to the presenting key's own tenant (`tenantDb(apiKey.tenantId)`),
// so /api/crm/* route handlers can stop importing the raw client the same
// way session-guarded routes already do.
//
// The lookup of WHICH key was presented is necessarily an unscoped read —
// there is no tenant to scope by until the key itself tells us one — so it
// deliberately uses `unsafeGlobalDb` directly (by its real, loud name) for
// that one query, exactly like auth.ts's own credentials lookup. Once the
// row comes back, every scoped query after that point uses `apiKey.tenantId`
// explicitly (via tenantDb()), never the unscoped client again.
export async function requireApiKey(
  request: NextRequest
): Promise<{ apiKey: ApiKey; db: TenantClient } | { response: NextResponse }> {
  const header = request.headers.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) {
    return { response: NextResponse.json({ error: "Missing Authorization: Bearer <key>" }, { status: 401 }) };
  }

  const keyHash = createHash("sha256").update(token).digest("hex");
  const apiKey = await unsafeGlobalDb.apiKey.findUnique({ where: { keyHash } });

  if (!apiKey || apiKey.revokedAt) {
    return { response: NextResponse.json({ error: "Invalid or revoked API key" }, { status: 401 }) };
  }

  // Best-effort, not awaited by the caller — a slow lastUsedAt write should
  // never add latency to the actual request. Deliberately still on
  // unsafeGlobalDb: it's an update-by-id on the very row we just resolved,
  // not a tenant-scoped read, and tenantDb()'s SET LOCAL transaction wrapper
  // would be pure overhead for a single fire-and-forget write.
  void unsafeGlobalDb.apiKey.update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } }).catch(() => undefined);

  // TODO(wave 2c — CRM route sweep): /api/crm/* route handlers still import
  // the old `db` and must be updated to destructure this `db` instead, the
  // same mechanical swap the session-guarded route sweeps are doing. Not
  // done here — see this task's brief: only this file's own compile
  // correctness is in scope, not the ~90 currently-failing route files.
  return { apiKey, db: tenantDb(apiKey.tenantId) };
}
