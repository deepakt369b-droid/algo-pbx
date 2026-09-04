import { NextResponse } from "next/server";
import { unsafeGlobalDb } from "@/lib/db";

export const dynamic = "force-dynamic";

// GET /api/health — unauthenticated liveness/readiness probe for
// docker-compose's `web` healthcheck. Previously there was no healthcheck
// on any of the five services, so `depends_on` only waited for a
// container to START, not to be ready — `web` could race Postgres (or
// come up "healthy" while its own DB connection was actually broken) with
// nothing surfacing that until a real request failed. Checks a trivial DB
// round-trip, not just "the Node process is alive".
export async function GET() {
  try {
    await unsafeGlobalDb.$queryRaw`SELECT 1`;
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ ok: false, error: err instanceof Error ? err.message : "unknown" }, { status: 503 });
  }
}
