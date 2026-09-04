import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
// True pre-tenant bootstrap — this route creates the very first user, so
// there is no session/tenant context to resolve a scoped client from at
// all (the opposite problem every other pre-session route in this domain
// has: those resolve an EXISTING user's tenant, this one has no user yet).
// unsafeGlobalDb is the only option; see the tenant-attachment comment on
// POST below for how the new admin gets a tenantId.
import { unsafeGlobalDb } from "@/lib/db";
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
  const count = await unsafeGlobalDb.user.count({ where: { role: "ADMIN" } });
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

  const existingEmail = await unsafeGlobalDb.user.findUnique({ where: { email: parsed.data.email } });
  if (existingEmail) {
    return NextResponse.json({ error: "An account with this email already exists." }, { status: 409 });
  }

  // Multi-tenant SaaS foundation, wave 2e: attach the new admin to "the"
  // tenant for this deployment. Wave 1's migration seeded exactly one
  // Tenant row (slug "sahara") for the current single-tenant-in-practice
  // reality, and this route — true first-run, before any user or session
  // exists — has no other signal (no host-based resolution, no invite) to
  // pick a tenant from. findFirst() rather than hardcoding the "sahara"
  // slug: it's the same assumption ("there is exactly one tenant today")
  // expressed more generally, so it keeps working unmodified if that seed
  // row is ever renamed. It will pick an ARBITRARY tenant if more than one
  // row exists — deliberately not "the right one" for a true multi-tenant
  // deployment. Wave 7 (real self-serve tenant provisioning) will replace
  // this with a proper "which tenant is this signup for" resolution
  // (subdomain/host-based, most likely); revisit this route then.
  const tenant = await unsafeGlobalDb.tenant.findFirst({ orderBy: { createdAt: "asc" } });
  if (!tenant) {
    return NextResponse.json(
      { error: "No tenant exists for this deployment. Run the tenancy migration/seed before setup." },
      { status: 503 }
    );
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);
  const user = await unsafeGlobalDb.user.create({
    data: {
      tenantId: tenant.id,
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

  await unsafeGlobalDb.auditLog.create({
    data: { action: "setup.create_first_admin", actorId: user.id, targetId: user.id, tenantId: user.tenantId, metadata: { email: user.email } },
  });

  return NextResponse.json({ ok: true });
});
