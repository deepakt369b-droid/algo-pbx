import { createHash, randomBytes, randomInt } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireStaffSession } from "@/lib/auth-guard";
import { regeneratePjsipConfigAndReload } from "@/lib/pjsip-provision";
import { regenerateVoicemailConfigAndReload } from "@/lib/voicemail-provision";
import { sendInviteEmail } from "@/lib/mail/resend";
import { withApiErrorHandler } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

// GET /api/admin/users — staff-only listing. Never returns passwordHash or
// the linked extension's sipSecret (see /api/extensions's GET for the same
// principle applied there).
export const GET = withApiErrorHandler(async function GET() {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const users = await db.user.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      disabled: true,
      createdAt: true,
      extension: { select: { number: true, kind: true, status: true } },
      invite: { select: { consumedAt: true, expiresAt: true } },
      // Registration status (agent-registration plan) — surfaced so an
      // admin can see who's still mid-onboarding and use the phone
      // verification override without needing a separate lookup.
      phoneE164: true,
      phoneVerifiedAt: true,
      phoneVerifiedByAdminId: true,
      photoPath: true,
      profileCompletedAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ users });
});

// POST /api/admin/users — creates a user with NO password and sends a
// single-use, 24h-expiry Resend invite email instead of an admin-typed
// "temporary password" that was never emailed, never rotatable, and had to
// be communicated out of band. This is the deliberate replacement for that
// flow — see Invite's schema.prisma comment and src/app/invite/[token]'s
// page for the consuming half. There is intentionally NO route anywhere
// that lets an agent change their own email or password after this — the
// requirement is that only an admin controls agent credentials, and the
// absence of a self-service route is what enforces that, not a permission
// check that could be bypassed.
//
// Authorization is stricter than plain requireStaffSession(): a SUPERVISOR
// may only create AGENT accounts; only ADMIN may create SUPERVISOR or
// ADMIN accounts.
const CreateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(["AGENT", "SUPERVISOR", "ADMIN"]).default("AGENT"),
  extensionNumber: z.string().regex(/^\d{3,6}$/).optional(),
  extensionKind: z.enum(["webrtc", "hardware"]).default("webrtc"),
});

const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

export const POST = withApiErrorHandler(async function POST(req: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const body = await req.json();
  const parsed = CreateUserSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { email, name, role, extensionNumber, extensionKind } = parsed.data;

  if (role !== "AGENT" && guard.session.user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Only ADMIN may create SUPERVISOR or ADMIN accounts." },
      { status: 403 }
    );
  }

  const sipSecret = extensionNumber ? randomBytes(24).toString("hex") : undefined;
  // 4-digit numeric PIN for VoicemailMain() access (Phase E) — matches
  // POST /api/extensions's generation, kept in sync there and here since
  // both are entry points for provisioning an Extension.
  const voicemailPin = extensionNumber ? String(randomInt(1000, 10000)) : undefined;

  const user = await db.user.create({
    data: {
      email,
      // No passwordHash at creation — see file header. Set exactly once,
      // by the agent, at /invite/[token].
      name,
      role,
      ...(extensionNumber
        ? { extension: { create: { number: extensionNumber, kind: extensionKind, sipSecret, voicemailPin } } }
        : {}),
    },
    include: { extension: true },
  });

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = createHash("sha256").update(rawToken).digest("hex");
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  await db.invite.create({
    data: { userId: user.id, tokenHash, expiresAt, createdById: guard.session.user.id },
  });

  const inviteUrl = `${process.env.AUTH_URL ?? ""}/invite/${rawToken}`;
  let emailWarning: string | undefined;
  try {
    await sendInviteEmail(email, name, inviteUrl);
  } catch (err) {
    // The user and invite still exist — an admin can resend (a future
    // "resend invite" action would create a fresh Invite row) or, for the
    // trial, hand the operator the URL directly since it's logged here
    // rather than swallowed silently.
    emailWarning = `User created, but the invite email failed to send: ${err instanceof Error ? err.message : "unknown error"}. Invite URL: ${inviteUrl}`;
  }

  let reloadWarning: string | undefined;
  if (extensionNumber) {
    try {
      await regeneratePjsipConfigAndReload();
      await regenerateVoicemailConfigAndReload();
    } catch (err) {
      reloadWarning = `User and extension saved, but reloading Asterisk failed: ${err instanceof Error ? err.message : "unknown error"}. The extension will not be able to register until this is retried.`;
    }
  }

  return NextResponse.json(
    {
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      // One-time disclosure, same principle as POST /api/extensions — not
      // returned again by GET.
      sipSecret,
      voicemailPin,
      warning: [emailWarning, reloadWarning].filter(Boolean).join(" ") || undefined,
    },
    { status: 201 }
  );
});
