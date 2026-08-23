"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";

// Two-phase login (Workstream 6 — new-device/new-IP 2FA). Converted from
// a server-action form (formerly ./actions.ts's loginAction, deleted —
// nothing else imported it) to a client component because the
// phone-verification round trip needs
// to happen INTERACTIVELY, between the password check and the actual
// signIn() call: POST /api/auth-2fa/pre-login checks the password and
// either clears a trusted device straight through or sends an OTP;
// POST /api/auth-2fa/verify confirms it. Only once one of those has set
// the short-lived otp_verified cookie does the final client-side
// signIn("credentials", ...) call succeed — src/auth.ts's authorize()
// requires that cookie for any user with a verified phone number.
type Phase = "credentials" | "otp";

export function LoginForm({ callbackUrl }: { callbackUrl?: string }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("credentials");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [maskedPhone, setMaskedPhone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const finishSignIn = async () => {
    // The otp_verified (and, on a fresh device, trusted_device) cookie
    // is already set by whichever route got us here — this call re-runs
    // authorize()'s full check (password + that cookie) and is what
    // actually creates the session.
    const result = await signIn("credentials", { email, password, redirect: false });
    if (result?.error) {
      setError("Invalid email or password.");
      setPhase("credentials");
      return;
    }
    router.push(callbackUrl || "/admin");
    router.refresh();
  };

  const submitCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/auth-2fa/pre-login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Invalid email or password.");
        return;
      }
      if (data.needs2fa) {
        setMaskedPhone(data.maskedPhone ?? null);
        setPhase("otp");
      } else {
        await finishSignIn();
      }
    } finally {
      setPending(false);
    }
  };

  const submitOtp = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/auth-2fa/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Incorrect code.");
        return;
      }
      await finishSignIn();
    } finally {
      setPending(false);
    }
  };

  if (phase === "otp") {
    return (
      <form onSubmit={submitOtp} className="glass-card flex w-full max-w-sm flex-col gap-4 p-8">
        <h1 className="text-lg font-semibold text-slate-100">Verify your device</h1>
        <p className="text-xs text-slate-400">
          We sent a code via WhatsApp to {maskedPhone ?? "your registered number"}.
        </p>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          placeholder="6-digit code"
          autoFocus
          className="rounded-lg border border-border bg-background px-3 py-2 text-center text-lg tracking-widest text-slate-100 outline-none focus:border-cyan"
        />
        {error && <p className="text-sm text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={pending || code.length !== 6}
          className="rounded-lg bg-cyan px-4 py-2 font-medium text-background transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {pending ? "Verifying…" : "Verify and sign in"}
        </button>
        <button type="button" onClick={() => setPhase("credentials")} className="text-xs text-slate-500 hover:text-slate-300">
          Back
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={submitCredentials} className="glass-card flex w-full max-w-sm flex-col gap-4 p-8">
      <h1 className="text-lg font-semibold text-slate-100">Algo PBX Sign In</h1>
      <input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        type="email"
        required
        placeholder="you@algopbx.local"
        className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan"
      />
      <input
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        type="password"
        required
        minLength={8}
        placeholder="Password"
        className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan"
      />
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-cyan px-4 py-2 font-medium text-background transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
