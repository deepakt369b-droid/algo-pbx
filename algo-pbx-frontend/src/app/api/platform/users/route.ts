import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { unsafeGlobalDb as db } from "@/lib/db";
import { requirePlatformOwner, requirePlatformSession } from "@/lib/platform-guard";
import { withApiErrorHandler } from "@/lib/api-handler";
import { recordPlatformAudit, requireReason, MissingReasonError } from "@/lib/platform/audit";

export const dynamic = "force-dynamic";

// Platform user management.
//
// GET is available to any platform session: knowing who else has access to
// this plane is exactly the kind of thing every operator should be able to
// check, and hiding the list would make an unnoticed rogue account easier,
// not harder. POST is owner-only.
//
// The one-time password is generated here, shown ONCE in the response, and
// never persisted in plaintext — only its bcrypt hash is stored. Combined
// with mustChangePassword and a null totpSecret, the new account cannot reach
// anything until the operator has completed the existing /platform/setup
// flow: change the password, then enrol TOTP. TOTP is mandatory on this plane
// from day one; there is no path that skips it.

const CreateSchema = z.object({
  email: z.string().email().max(320),
  name: z.string().min(1).max(200),
  role: z.enum(["PLATFORM_OWNER", "PLATFORM_SUPPORT"]).default("PLATFORM_SUPPORT"),
  reason: z.string(),
  // Creating another owner hands over provisioning, billing, offboarding and
  // the telephony kill switch. Typing the email is the deliberate friction.
  confirmEmail: z.string().optional(),
});

/** 20 bytes of base64url ≈ 160 bits. Long enough that the one-time window is
 * not the weak link, short enough to read aloud over a phone if it must be. */
function generateOneTimePassword(): string {
  return randomBytes(20).toString("base64url");
}

export const GET = withApiErrorHandler(async function GET() {
  const guard = await requirePlatformSession();
  if ("response" in guard) return guard.response;

  const users = await db.platformUser.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      disabled: true,
      disabledAt: true,
      lastLoginAt: true,
      totpConfirmedAt: true,
      mustChangePassword: true,
      totpResetAt: true,
      createdAt: true,
      // passwordHash is never selected. It has no business leaving the
      // database, and a select:true here would put every operator's hash in
      // a JSON response.
    },
    orderBy: [{ disabled: "asc" }, { createdAt: "asc" }],
  });

  return NextResponse.json({ users });
});

export const POST = withApiErrorHandler(async function POST(req: NextRequest) {
  const guard = await requirePlatformOwner();
  if ("response" in guard) return guard.response;

  const parsed = CreateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }
  const { email, name, role, confirmEmail } = parsed.data;

  let reason: string;
  try {
    reason = requireReason(parsed.data.reason, "platform_user.create");
  } catch (err) {
    if (err instanceof MissingReasonError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  if (role === "PLATFORM_OWNER" && confirmEmail !== email) {
    return NextResponse.json(
      {
        error:
          "Creating a PLATFORM_OWNER requires typed confirmation: send confirmEmail matching the email exactly.",
      },
      { status: 400 }
    );
  }

  const existing = await db.platformUser.findUnique({ where: { email }, select: { id: true } });
  if (existing) {
    return NextResponse.json({ error: "A platform user with that email already exists." }, { status: 409 });
  }

  // Cross-plane collision check. Email is globally unique among tenant Users
  // by deliberate design (Requirement A: no tenant picker on the login form),
  // and letting one address exist on both planes would make "which plane am I
  // signing into" ambiguous for a human and for our own audit trails.
  const tenantUser = await db.user.findUnique({ where: { email }, select: { id: true } });
  if (tenantUser) {
    return NextResponse.json(
      { error: "That email already belongs to a tenant user. The two planes must stay separate." },
      { status: 409 }
    );
  }

  const oneTimePassword = generateOneTimePassword();
  const passwordHash = await bcrypt.hash(oneTimePassword, 12);

  const created = await db.$transaction(async (tx) => {
    const u = await tx.platformUser.create({
      data: {
        email,
        name,
        role,
        passwordHash,
        // Both required for the forced setup flow: change the password, then
        // enrol TOTP. A row with totpSecret null cannot complete a login.
        mustChangePassword: true,
        totpSecret: null,
        totpConfirmedAt: null,
        createdById: guard.session.user.id,
      },
      select: { id: true, email: true, name: true, role: true, createdAt: true },
    });

    await recordPlatformAudit(
      {
        action: "platform_user.create",
        platformUserId: guard.session.user.id,
        reason,
        metadata: { createdUserId: u.id, createdEmail: u.email, role },
      },
      tx
    );

    return u;
  });

  return NextResponse.json(
    {
      user: created,
      // Shown once. Not stored anywhere in plaintext, not recoverable, and
      // deliberately not emailed — handing it over is a human step, and the
      // account is useless until the recipient completes password change and
      // TOTP enrolment anyway.
      oneTimePassword,
      notice:
        "This password is shown once and cannot be retrieved again. The account must change it and enrol TOTP at first login.",
    },
    { status: 201 }
  );
});
