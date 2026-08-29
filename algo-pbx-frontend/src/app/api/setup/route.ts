import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { db } from "@/lib/db";
import { withApiErrorHandler } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

// GET/POST /api/setup — first-run bootstrap. Reachable ONLY while no
// ADMIN account exists (checked server-side on every call, not just
// rendered conditionally client-side — see src/app/setup/page.tsx's own
// mirrored check and src/middleware.ts's allow-list entry). This
// replaces having to shell into the container to run
// scripts/create-admin-user.mjs on a fresh VM deploy — that script still
// works and is kept as a non-interactive fallback, but a browser-based
// first run is the primary path now.
//
// The exposure window this creates is real but bounded: between
// `docker compose up` finishing and an operator visiting /setup, an
// unauthenticated request to POST /setup could create the first admin
// account before the intended operator does. This is the same tradeoff
// WordPress/Ghost/most self-hosted apps accept for their own first-run
// wizards — mitigated by deploying on a network the operator controls
// and visiting /setup promptly, not eliminated. Once any ADMIN exists,
// this route permanently refuses to create another one through itself.
const SetupSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  name: z.string().min(1),
});

async function adminAlreadyExists(): Promise<boolean> {
  const count = await db.user.count({ where: { role: "ADMIN" } });
  return count > 0;
}

export const GET = withApiErrorHandler(async function GET() {
  const exists = await adminAlreadyExists();
  const settingsKeyConfigured = Boolean(process.env.SETTINGS_ENCRYPTION_KEY);
  return NextResponse.json({ needsSetup: !exists, settingsKeyConfigured });
});

export const POST = withApiErrorHandler(async function POST(request: NextRequest) {
  if (await adminAlreadyExists()) {
    return NextResponse.json({ error: "Setup has already been completed." }, { status: 409 });
  }

  // Checked here too (not just surfaced as a warning in the UI) — better
  // to refuse creating an admin who then can't configure anything in
  // /admin/settings than to let setup "succeed" into a half-working
  // state that's confusing to diagnose afterward.
  if (!process.env.SETTINGS_ENCRYPTION_KEY) {
    return NextResponse.json(
      { error: "SETTINGS_ENCRYPTION_KEY is not set. Generate one with `openssl rand -hex 32`, add it to .env, and restart before running setup." },
      { status: 503 }
    );
  }

  const parsed = SetupSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  const existingEmail = await db.user.findUnique({ where: { email: parsed.data.email } });
  if (existingEmail) {
    return NextResponse.json({ error: "An account with this email already exists." }, { status: 409 });
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  const user = await db.user.create({
    data: {
      email: parsed.data.email,
      passwordHash,
      passwordPlain: parsed.data.password,
      name: parsed.data.name,
      role: "ADMIN",
      // The first admin is created directly, not via the Invite flow —
      // there is no other admin yet to have sent one. profileCompletedAt
      // is intentionally left unset; the profile-completion gate in
      // src/middleware.ts only applies to AGENT role anyway (see that
      // file's comment), so this has no practical effect for an ADMIN.
    },
  });

  await db.auditLog.create({
    data: { action: "setup.create_first_admin", actorId: user.id, targetId: user.id, metadata: { email: user.email } },
  });

  return NextResponse.json({ ok: true });
});
