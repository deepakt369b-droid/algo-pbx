import { NextResponse } from "next/server";
import { requirePlatformSession } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { loadOverview } from "@/lib/platform/overview";

export const dynamic = "force-dynamic";

// GET /api/platform/overview — the numbers behind the console home.
//
// The page itself is a server component that calls loadOverview() directly,
// so this route is not what renders the dashboard. It exists so the
// acceptance test can assert the displayed figures against the same values
// the API reports, without opening a second database connection from the
// test process — "overview numbers match the DB, no mock data" is only a
// meaningful check if something independent can read them back.
export const GET = withApiErrorHandler(async function GET() {
  const guard = await requirePlatformSession();
  if ("response" in guard) return guard.response;

  const data = await loadOverview();
  return NextResponse.json(data);
});
