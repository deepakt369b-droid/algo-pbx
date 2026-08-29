import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireSession } from "@/lib/auth-guard";
import { normalizeToE164 } from "@/lib/phone-normalize";
import { isProfileComplete, maybeCompleteProfile } from "@/lib/registration";
import { withApiErrorHandler } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

// POST /api/register — the profile half of registration (name, address,
// contact number). Phone VERIFICATION is a separate step
// (POST /api/register/verify-phone or the WhatsApp-fallback pair) since
// it involves a round trip to Firebase/WhatsApp the client drives
// independently. This route only ever writes name/address/phoneE164 —
// phoneVerifiedAt is set exclusively by the verification routes, never
// here, so a client cannot claim verification by simply resubmitting
// this form with a fabricated flag.
//
// Deliberately NOT gated by profileComplete (that would be circular —
// this route is how profileComplete becomes true) but IS gated by a
// live session: the agent must already have a password (via
// /invite/[token]) before they can reach this step at all.
const RegisterSchema = z.object({
  name: z.string().min(1).max(200),
  address: z.string().min(1).max(1000),
  phone: z.string().min(3).max(20),
});

export const POST = withApiErrorHandler(async function POST(request: NextRequest) {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;

  const parsed = RegisterSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid payload", details: parsed.error.flatten() }, { status: 400 });
  }

  // Default country India — agents are India-based per the plan; an
  // agent entering a 10-digit local number without a country code
  // parses correctly instead of failing.
  const phoneE164 = normalizeToE164(parsed.data.phone, "IN");
  if (!phoneE164) {
    return NextResponse.json({ error: "Contact number is not a valid, parseable phone number." }, { status: 400 });
  }

  const existingOwner = await db.user.findUnique({ where: { phoneE164 }, select: { id: true } });
  if (existingOwner && existingOwner.id !== guard.session.user.id) {
    return NextResponse.json({ error: "This phone number is already registered to another account." }, { status: 409 });
  }

  const current = await db.user.findUnique({ where: { id: guard.session.user.id }, select: { phoneE164: true, phoneVerifiedAt: true } });

  // Changing the phone number after it was already verified invalidates
  // that verification — a new number needs a fresh OTP round-trip, not
  // an inherited "verified" status from a different number entirely.
  const phoneChanged = current?.phoneE164 !== phoneE164;

  await db.user.update({
    where: { id: guard.session.user.id },
    data: {
      name: parsed.data.name,
      address: parsed.data.address,
      phoneE164,
      ...(phoneChanged ? { phoneVerifiedAt: null, phoneVerifiedByAdminId: null } : {}),
    },
  });

  await maybeCompleteProfile(guard.session.user.id);

  return NextResponse.json({ ok: true, phoneE164, phoneVerified: !phoneChanged && Boolean(current?.phoneVerifiedAt) });
});

// GET /api/register — the registration page's own state check, so it
// can render "already submitted, verify your phone" vs. the blank form
// vs. "already complete, redirecting" without guessing from client state.
export const GET = withApiErrorHandler(async function GET() {
  const guard = await requireSession();
  if ("response" in guard) return guard.response;

  const user = await db.user.findUnique({
    where: { id: guard.session.user.id },
    select: {
      name: true,
      address: true,
      phoneE164: true,
      phoneVerifiedAt: true,
      photoPath: true,
      profileCompletedAt: true,
    },
  });

  return NextResponse.json({
    name: user?.name ?? "",
    address: user?.address ?? "",
    phoneE164: user?.phoneE164 ?? "",
    phoneVerified: Boolean(user?.phoneVerifiedAt),
    hasPhoto: Boolean(user?.photoPath),
    // Recompute from the fields rather than trusting profileCompletedAt —
    // middleware and /api/me/sip-credentials both gate on the live
    // isProfileComplete() check, and a stale/incorrectly-stamped
    // timestamp here would put the page and middleware into a
    // /register <-> /agent redirect loop.
    profileComplete: Boolean(user) && isProfileComplete(user!),
  });
});
