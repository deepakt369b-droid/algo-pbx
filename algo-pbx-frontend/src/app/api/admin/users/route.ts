import { createHash, randomBytes, randomInt } from "node:crypto";
import bcrypt from "bcryptjs";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireStaffSession } from "@/lib/auth-guard";
import { regeneratePjsipConfigAndReload } from "@/lib/pjsip-provision";
import { regenerateVoicemailConfigAndReload } from "@/lib/voicemail-provision";
import { sendInviteEmail } from "@/lib/mail/resend";
import { withApiErrorHandler } from "@/lib/api-handler";
import { normalizeToE164 } from "@/lib/phone-normalize";
import { getAmiClient } from "@/lib/ami-client";
import { addQueueMember } from "@/lib/queue-membership";

export const dynamic = "force-dynamic";

// GET /api/admin/users — staff-only listing. Never returns passwordHash or
// the linked extension's sipSecret (see /api/extensions's GET for the same
// principle applied there).
export const GET = withApiErrorHandler(async function GET() {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  // Owner override (2026-08-29): plaintext passwords are surfaced to ADMIN
  // sessions only — a SUPERVISOR who can list users still never sees them.
  // See memory owner-overrides-security-model.
  const isAdmin = guard.session.user.role === "ADMIN";

  const users = await db.user.findMany({
    select: {
      id: true,
      email: true,
      name: true,
      role: true,
      disabled: true,
      createdAt: true,
      passwordPlain: isAdmin,
      extension: { select: { number: true, kind: true, status: true } },
      waInstance: { select: { id: true, label: true, simPort: true, status: true, phoneE164: true } },
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

// POST /api/admin/users — two credential-bootstrap paths, admin's choice:
//
//   1. Invite (password omitted): the original flow — the user is created
//      with NO password, a single-use 24h Resend invite link is sent, and
//      the agent sets their own password once at /invite/[token]. Keeps
//      the property that an admin never learns the agent's password.
//   2. Direct create (password supplied): the admin sets email + password
//      + phone in one form, no invite email round-trip. Added because an
//      invite that never arrives (bad email, no inbox access) was a dead
//      end with no recovery — see the now-superseded "no admin
//      password-set path exists" gap. The admin DOES learn this password
//      (they typed it), which is the deliberate tradeoff for not
//      depending on email deliverability; there is still no route to
//      RE-set a password after creation for either path — rotate by
//      disabling the account and creating a new one, matching the
//      existing "credentials are admin-controlled, not self-service"
//      policy.
//
// Either path may also allocate an Extension (auto-numbered if
// extensionNumber is omitted) and a WhatsApp SIM port in the same
// request, added atomically with the user row.
//
// Authorization is stricter than plain requireStaffSession(): a SUPERVISOR
// may only create AGENT accounts; only ADMIN may create SUPERVISOR or
// ADMIN accounts.
const CreateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1),
  role: z.enum(["AGENT", "SUPERVISOR", "ADMIN"]).default("AGENT"),
  // Omit to use the invite-email flow; supply to set it directly. Long
  // minimum (not 8) since this is typed once by an admin, not memorized
  // under login-form UX pressure.
  password: z.string().min(12).max(200).optional(),
  phoneE164: z.string().min(6).optional(),
  extensionNumber: z.string().regex(/^\d{3,6}$/).optional(),
  // "auto" allocates the lowest free number in the webrtc range
  // (1001-1999) rather than requiring the admin to know what's free.
  autoExtension: z.boolean().default(false),
  extensionKind: z.enum(["webrtc", "hardware"]).default("webrtc"),
  simPort: z.number().int().min(1).max(4).optional(),
});

const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
const AUTO_EXTENSION_RANGE = { start: 1001, end: 1999 };

async function nextFreeExtensionNumber(): Promise<string | null> {
  const existing = new Set((await db.extension.findMany({ select: { number: true } })).map((e) => e.number));
  for (let n = AUTO_EXTENSION_RANGE.start; n <= AUTO_EXTENSION_RANGE.end; n++) {
    if (!existing.has(String(n))) return String(n);
  }
  return null;
}

export const POST = withApiErrorHandler(async function POST(req: NextRequest) {
  const guard = await requireStaffSession();
  if ("response" in guard) return guard.response;

  const body = await req.json();
  const parsed = CreateUserSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const { email, name, role, password, phoneE164: rawPhone, extensionNumber: requestedExtension, autoExtension, extensionKind, simPort } = parsed.data;

  if (role !== "AGENT" && guard.session.user.role !== "ADMIN") {
    return NextResponse.json(
      { error: "Only ADMIN may create SUPERVISOR or ADMIN accounts." },
      { status: 403 }
    );
  }

  let phoneE164: string | null = null;
  if (rawPhone) {
    phoneE164 = normalizeToE164(rawPhone);
    if (!phoneE164) {
      return NextResponse.json({ error: "Invalid payload", details: { phoneE164: ["Not a valid phone number."] } }, { status: 400 });
    }
    const phoneConflict = await db.user.findUnique({ where: { phoneE164 } });
    if (phoneConflict) {
      return NextResponse.json({ error: `${phoneE164} is already linked to another account.` }, { status: 409 });
    }
  }

  if (simPort) {
    const existing = await db.waInstance.findUnique({
      where: { simPort },
      include: { assignedUser: { select: { name: true, email: true } } },
    });
    if (!existing) {
      return NextResponse.json({ error: `SIM port ${simPort} has no paired WhatsApp instance yet — pair it in /admin/whatsapp first.` }, { status: 409 });
    }
    if (existing.assignedUserId && existing.assignedUser) {
      // Confirmed live 2026-08-29: this used to say only "already assigned
      // to another agent" with no way to tell WHO to revoke it from —
      // naming the holder is the one real gap in an otherwise-correct
      // exclusive/revoke-only assignment model (see PATCH
      // /api/admin/users/[id] for the matching fix on reassignment).
      return NextResponse.json(
        { error: `SIM port ${simPort} is already assigned to ${existing.assignedUser.name} (${existing.assignedUser.email}).` },
        { status: 409 }
      );
    }
  }

  let extensionNumber = requestedExtension;
  if (!extensionNumber && autoExtension) {
    extensionNumber = (await nextFreeExtensionNumber()) ?? undefined;
    if (!extensionNumber) {
      return NextResponse.json({ error: `No free extension number in ${AUTO_EXTENSION_RANGE.start}-${AUTO_EXTENSION_RANGE.end}.` }, { status: 409 });
    }
  }

  const sipSecret = extensionNumber ? randomBytes(24).toString("hex") : undefined;
  // 4-digit numeric PIN for VoicemailMain() access (Phase E) — matches
  // POST /api/extensions's generation, kept in sync there and here since
  // both are entry points for provisioning an Extension.
  const voicemailPin = extensionNumber ? String(randomInt(1000, 10000)) : undefined;
  const passwordHash = password ? await bcrypt.hash(password, 12) : undefined;

  const user = await db.user.create({
    data: {
      email,
      name,
      role,
      passwordHash,
      passwordPlain: password,
      ...(phoneE164
        ? {
            phoneE164,
            // Direct-create is an ADMIN OVERRIDE verification, not a real
            // OTP round-trip — deliberately weaker and distinguishable
            // (phoneVerifiedByAdminId set), same as the existing
            // verifyPhoneOverride action in [id]/route.ts. Also exempts
            // this user's login from the 2FA OTP challenge (src/auth.ts,
            // src/app/api/auth-2fa/pre-login) so their first login isn't
            // blocked on a WhatsApp instance that may not be paired yet.
            phoneVerifiedAt: new Date(),
            phoneVerifiedByAdminId: guard.session.user.id,
            // profileCompletedAt is NOT set here: this form has no address
            // field, and isProfileComplete() (which middleware and
            // /api/me/sip-credentials recompute live from the fields)
            // requires one. Stamping the timestamp without an address
            // desyncs the two checks into a /register <-> /agent redirect
            // loop. The agent supplies the address on first login; the
            // pre-verified phone just spares them the OTP step.
          }
        : {}),
      ...(extensionNumber
        ? { extension: { create: { number: extensionNumber, kind: extensionKind, sipSecret, voicemailPin } } }
        : {}),
      ...(simPort ? { waInstance: { connect: { simPort } } } : {}),
    },
    include: { extension: true, waInstance: true },
  });

  let inviteUrl: string | undefined;
  let emailWarning: string | undefined;
  if (!password) {
    const rawToken = randomBytes(32).toString("hex");
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

    await db.invite.create({
      data: { userId: user.id, tokenHash, expiresAt, createdById: guard.session.user.id },
    });

    inviteUrl = `${process.env.AUTH_URL ?? ""}/invite/${rawToken}`;
    try {
      await sendInviteEmail(email, name, inviteUrl);
    } catch (err) {
      // The user and invite still exist — an admin can resend (a future
      // "resend invite" action would create a fresh Invite row) or, for
      // the trial, hand the operator the URL directly since it's logged
      // here rather than swallowed silently.
      emailWarning = `User created, but the invite email failed to send: ${err instanceof Error ? err.message : "unknown error"}. Invite URL: ${inviteUrl}`;
    }
  }

  let reloadWarning: string | undefined;
  if (extensionNumber) {
    try {
      await regeneratePjsipConfigAndReload();
      await regenerateVoicemailConfigAndReload();
    } catch (err) {
      reloadWarning = `User and extension saved, but reloading Asterisk failed: ${err instanceof Error ? err.message : "unknown error"}. The extension will not be able to register until this is retried.`;
    }

    // Puts the new agent into support_queue immediately — without this an
    // inbound call could never reach them (queues.conf no longer seeds a
    // static member; see that file's comment). Best-effort: AMI being
    // down at creation time shouldn't block the account from existing,
    // but IS surfaced rather than silently skipped.
    try {
      await addQueueMember(getAmiClient(), extensionNumber);
    } catch (err) {
      reloadWarning = [reloadWarning, `Could not add extension ${extensionNumber} to the support queue: ${err instanceof Error ? err.message : "unknown error"}. Add it manually once AMI is reachable.`]
        .filter(Boolean)
        .join(" ");
    }
  }

  return NextResponse.json(
    {
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      // One-time disclosure, same principle as POST /api/extensions — not
      // returned again by GET.
      sipSecret,
      voicemailPin,
      inviteUrl,
      warning: [emailWarning, reloadWarning].filter(Boolean).join(" ") || undefined,
    },
    { status: 201 }
  );
});
