"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { startFirebasePhoneVerification, resetRecaptcha } from "@/lib/firebase/client";
import type { ConfirmationResult } from "firebase/auth";

// Agent registration form — reached after first login (see
// src/middleware.ts's hard gate), separate from /invite/[token] which
// only ever sets a password (see that page's own header comment on why
// it stays a single-purpose, once-only page). Three steps in one page,
// not a route-per-step wizard, since the whole thing is small and the
// steps aren't independently resumable in a way that benefits from
// separate URLs — the GET /api/register state check on mount handles
// "agent left partway through and came back" instead.
//
// Step 1: name/address/phone (POST /api/register).
// Step 2: phone verification. The channel is admin-selected
//         (OTP_CHANNEL in /admin/settings, read from
//         GET /api/config/public) and defaults to OPENWA:
//           - OPENWA / META_CLOUD: server-driven send/verify
//             (POST /api/register/send-fallback-otp +
//             /verify-fallback-otp — same routes originally built as the
//             Firebase FALLBACK, now channel-agnostic since
//             src/lib/otp/service.ts's sendOtp() branches on OTP_CHANNEL
//             internally). No Firebase project or Meta template is
//             needed for the OPENWA case — this is what makes OTP work
//             with zero external setup.
//           - FIREBASE: the client-driven Firebase Phone Auth flow
//             (src/lib/firebase/client.ts), with the OpenWA/Meta
//             send/verify routes offered as an in-page fallback if the
//             Firebase step itself errors — never tried first, since
//             that path exists specifically for when Firebase is what's
//             configured but isn't working for a given number.
// Step 3: photo upload (POST /api/register/photo) — optional; a missing
//         photo does not block completion, see src/lib/registration.ts's
//         isProfileComplete() comment for why.
type Step = "profile" | "verify" | "photo" | "done";
type OtpChannel = "OPENWA" | "META_CLOUD" | "FIREBASE";

const OTP_INPUT_PATTERN = /^\d{6}$/;

export default function RegisterPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState<Step>("profile");
  const [otpChannel, setOtpChannel] = useState<OtpChannel>("OPENWA");

  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Firebase phone-auth state — only ever used when otpChannel === "FIREBASE".
  const confirmationRef = useRef<ConfirmationResult | null>(null);
  const [firebaseCode, setFirebaseCode] = useState("");
  const [firebaseSent, setFirebaseSent] = useState(false);
  const [firebaseError, setFirebaseError] = useState<string | null>(null);

  // WhatsApp send/verify state — the PRIMARY flow when otpChannel is
  // OPENWA/META_CLOUD (shown immediately, no "fallback" framing), or the
  // in-page fallback when otpChannel is FIREBASE and that step errors.
  const [fallbackOffered, setFallbackOffered] = useState(false);
  const [fallbackSent, setFallbackSent] = useState(false);
  const [fallbackCode, setFallbackCode] = useState("");

  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [photoFile, setPhotoFile] = useState<File | null>(null);

  useEffect(() => {
    fetch("/api/config/public")
      .then((r) => r.json())
      .then((data) => setOtpChannel((data.otpChannel as OtpChannel) || "OPENWA"))
      .catch(() => setOtpChannel("OPENWA"));

    fetch("/api/register")
      .then((r) => r.json())
      .then((data) => {
        if (data.profileComplete) {
          router.replace("/agent");
          return;
        }
        setName(data.name ?? "");
        setAddress(data.address ?? "");
        setPhone(data.phoneE164 ?? "");
        // Only skip past the profile step if name AND address are already
        // on file — an admin-created agent has a pre-verified phone but no
        // address yet, and jumping straight to the photo step would let
        // them "finish" with an incomplete profile and loop at /agent.
        const profileFilled = Boolean(data.name && data.address);
        if (profileFilled && data.phoneVerified) setStep(data.hasPhoto ? "done" : "photo");
        else if (profileFilled && !data.phoneVerified) setStep("verify");
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [router]);

  const submitProfile = async () => {
    setError(null);
    if (!name.trim() || !address.trim() || !phone.trim()) {
      setError("All fields are required.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, address, phone }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Failed to save profile.");
        return;
      }
      if (data.phoneVerified) {
        setStep("photo");
      } else {
        setStep("verify");
      }
    } finally {
      setSubmitting(false);
    }
  };

  const sendFirebaseCode = async () => {
    setFirebaseError(null);
    try {
      confirmationRef.current = await startFirebasePhoneVerification(phone, "firebase-recaptcha-container");
      setFirebaseSent(true);
    } catch (err) {
      // Firebase failed to even SEND the code (misconfigured project,
      // reCAPTCHA failure, network issue, or the number is genuinely
      // undeliverable via SMS) — this is the trigger for offering the
      // WhatsApp fallback. Never auto-fires the fallback silently; the
      // agent sees why and chooses.
      setFirebaseError(err instanceof Error ? err.message : "Could not send verification code.");
      setFallbackOffered(true);
      resetRecaptcha();
    }
  };

  const confirmFirebaseCode = async () => {
    setFirebaseError(null);
    if (!confirmationRef.current) return;
    setSubmitting(true);
    try {
      const credential = await confirmationRef.current.confirm(firebaseCode);
      const idToken = await credential.user.getIdToken();
      const res = await fetch("/api/register/verify-phone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFirebaseError(data.error ?? "Verification failed.");
        return;
      }
      setStep("photo");
    } catch (err) {
      // A wrong CODE (not a send failure) also offers the fallback —
      // an agent who mistypes repeatedly should not be stuck with no
      // other path forward.
      setFirebaseError(err instanceof Error ? err.message : "Incorrect code.");
      setFallbackOffered(true);
    } finally {
      setSubmitting(false);
    }
  };

  const sendFallbackOtp = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/register/send-fallback-otp", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Could not send WhatsApp code.");
        return;
      }
      setFallbackSent(true);
    } finally {
      setSubmitting(false);
    }
  };

  const confirmFallbackOtp = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch("/api/register/verify-fallback-otp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: fallbackCode }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Incorrect code.");
        return;
      }
      setStep("photo");
    } finally {
      setSubmitting(false);
    }
  };

  const onPhotoChange = (file: File | null) => {
    setPhotoFile(file);
    setPhotoPreview(file ? URL.createObjectURL(file) : null);
  };

  const submitPhoto = async () => {
    setError(null);
    if (!photoFile) {
      // Photo is optional (see file header) — skipping straight to done
      // is a legitimate action, not an error state.
      finishRegistration();
      return;
    }
    setSubmitting(true);
    try {
      const form = new FormData();
      form.append("photo", photoFile);
      const res = await fetch("/api/register/photo", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Photo upload failed.");
        return;
      }
      finishRegistration();
    } finally {
      setSubmitting(false);
    }
  };

  const finishRegistration = () => {
    setStep("done");
    setTimeout(() => router.push("/agent"), 1500);
  };

  if (loading) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-sm text-slate-400">Loading...</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-8">
      <div className="glass-card w-full max-w-md p-6">
        <h1 className="mb-1 text-lg font-semibold text-slate-100">Complete your registration</h1>
        <p className="mb-4 text-xs text-slate-500">
          {step === "profile" && "Step 1 of 3 — your details"}
          {step === "verify" && "Step 2 of 3 — verify your phone number"}
          {step === "photo" && "Step 3 of 3 — profile photo (optional)"}
          {step === "done" && "All set"}
        </p>

        {step === "profile" && (
          <div className="flex flex-col gap-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Full name"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
            />
            <textarea
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="Address"
              rows={3}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
            />
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="Contact number, e.g. 98765 43210 or +91 98765 43210"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
            />
            {error && <p className="text-xs text-red-400">{error}</p>}
            <button
              onClick={submitProfile}
              disabled={submitting}
              className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
            >
              Continue
            </button>
          </div>
        )}

        {step === "verify" && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-slate-400">
              We&apos;ll send a code to {phone} via {otpChannel === "FIREBASE" ? "SMS" : "WhatsApp"}.
            </p>

            {otpChannel === "FIREBASE" && (
              <>
                <div id="firebase-recaptcha-container" />

                {!firebaseSent && !fallbackOffered && (
                  <button onClick={sendFirebaseCode} className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-background">
                    Send verification code
                  </button>
                )}

                {firebaseSent && !fallbackOffered && (
                  <>
                    <input
                      value={firebaseCode}
                      onChange={(e) => setFirebaseCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      placeholder="6-digit code"
                      className="rounded-lg border border-border bg-background px-3 py-2 text-center text-lg tracking-widest outline-none focus:border-cyan"
                    />
                    <button
                      onClick={confirmFirebaseCode}
                      disabled={!OTP_INPUT_PATTERN.test(firebaseCode) || submitting}
                      className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
                    >
                      Verify
                    </button>
                  </>
                )}

                {firebaseError && <p className="text-xs text-red-400">{firebaseError}</p>}
              </>
            )}

            {/* WhatsApp send/verify — the PRIMARY (and only) flow when
                otpChannel is OPENWA/META_CLOUD, shown immediately with no
                "fallback" framing; or the in-page fallback offered after a
                Firebase send/verify error when otpChannel is FIREBASE. */}
            {(otpChannel !== "FIREBASE" || fallbackOffered) && (
              <div className={otpChannel === "FIREBASE" ? "mt-2 flex flex-col gap-2 rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-3" : "flex flex-col gap-2"}>
                {otpChannel === "FIREBASE" && (
                  <p className="text-xs text-yellow-400">
                    SMS verification didn&apos;t go through. We can send a code via WhatsApp instead.
                  </p>
                )}
                {!fallbackSent ? (
                  <button
                    onClick={sendFallbackOtp}
                    disabled={submitting}
                    className={otpChannel === "FIREBASE" ? "rounded-lg bg-blue px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50" : "rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-background disabled:opacity-50"}
                  >
                    Send verification code
                  </button>
                ) : (
                  <>
                    <input
                      value={fallbackCode}
                      onChange={(e) => setFallbackCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                      placeholder="6-digit code"
                      className="rounded-lg border border-border bg-background px-3 py-2 text-center text-lg tracking-widest outline-none focus:border-cyan"
                    />
                    <button
                      onClick={confirmFallbackOtp}
                      disabled={!OTP_INPUT_PATTERN.test(fallbackCode) || submitting}
                      className={otpChannel === "FIREBASE" ? "rounded-lg bg-blue px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50" : "rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-background disabled:opacity-50"}
                    >
                      Verify
                    </button>
                  </>
                )}
                {error && <p className="text-xs text-red-400">{error}</p>}
                <p className="text-xs text-slate-600">
                  Not receiving a code? Ask an administrator to verify your number manually.
                </p>
              </div>
            )}
          </div>
        )}

        {step === "photo" && (
          <div className="flex flex-col gap-3">
            {photoPreview && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photoPreview} alt="Preview" className="mx-auto h-32 w-32 rounded-full object-cover" />
            )}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              onChange={(e) => onPhotoChange(e.target.files?.[0] ?? null)}
              className="text-xs text-slate-400"
            />
            {error && <p className="text-xs text-red-400">{error}</p>}
            <button
              onClick={submitPhoto}
              disabled={submitting}
              className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
            >
              {photoFile ? "Upload and finish" : "Skip and finish"}
            </button>
          </div>
        )}

        {step === "done" && <p className="text-sm text-green-400">Registration complete. Taking you to your workspace...</p>}
      </div>
    </main>
  );
}
