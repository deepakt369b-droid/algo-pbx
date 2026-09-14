import { timingSafeEqual } from "node:crypto";
import type { NextRequest } from "next/server";

// Shared machine-to-machine auth for src/app/api/internal/ai/** — the
// sidecar (W4) has no session cookie, so every route in this tree is
// guarded by a constant-time comparison against a shared secret instead
// (same shape as src/app/api/cdr/route.ts's isAuthorizedIngestRequest, just
// a custom header instead of `Authorization: Bearer`, per
// .agents/hybrid-ai/contracts.md: "Auth: header `x-internal-secret` ==
// process.env.AI_SIDECAR_SHARED_SECRET"). Fails closed if the env var was
// never configured.
export function isAuthorizedInternalAiRequest(req: NextRequest): boolean {
  const expected = process.env.AI_SIDECAR_SHARED_SECRET;
  if (!expected) return false;
  const provided = req.headers.get("x-internal-secret") ?? "";
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
