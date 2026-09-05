import { NextResponse } from "next/server";
import { requirePlatformSession } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { runPlatformHealthChecks } from "@/lib/platform/health-checks";

export const dynamic = "force-dynamic";

// GET /api/platform/health — shared-infrastructure status for the console's
// health strip and topbar pill.
//
// requirePlatformSession(), not requirePlatformOwner(): infrastructure status
// is not tenant content, and a PLATFORM_SUPPORT operator who cannot see that
// Postgres is down is a support operator who cannot do their job. It is still
// authenticated — the detail strings name internal hostnames, file paths and
// container names that have no business being public.
export const GET = withApiErrorHandler(async function GET() {
  const guard = await requirePlatformSession();
  if ("response" in guard) return guard.response;

  const result = await runPlatformHealthChecks();
  return NextResponse.json(result);
});
