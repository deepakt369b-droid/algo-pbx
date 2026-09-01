"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Self-service password reset (Loop C3) — mirrors login-form.tsx's
// two-phase shape (request a code, then submit it) for the same reason:
// the WhatsApp OTP round-trip needs an interactive step between "who are
// you" and "here's your new password." Deliberately shows the exact same
// generic message regardless of whether the email matched an account —
// see /api/auth/forgot-password's own comment for the enumeration-safety
// reasoning this mirrors.
type Phase = "request" | "reset" | "done";

export default function ForgotPasswordPage() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("request");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const requestCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/forgot-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const data = await res.json().catch(() => null);
      setMessage(data?.message ?? "If that account exists, a code was sent.");
      setPhase("reset");
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  };

  const submitReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code, newPassword }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) {
        setError(data?.error ?? "Something went wrong. Please try again.");
        return;
      }
      setPhase("done");
      setTimeout(() => router.push("/login"), 2000);
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-8">
      {phase === "request" && (
        <form onSubmit={requestCode} className="glass-card flex w-full max-w-sm flex-col gap-4 p-8">
          <h1 className="text-lg font-semibold text-primary">Reset your password</h1>
          <p className="text-xs text-secondary">
            We&apos;ll send a code via WhatsApp to the phone number on your account, if you have one verified.
          </p>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            type="email"
            required
            placeholder="you@algopbx.local"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
          />
          {error && <p className="text-sm text-danger">{error}</p>}
          <button
            type="submit"
            disabled={pending}
            className="rounded-lg bg-cyan px-4 py-2 font-medium text-accent-fg transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? "Sending…" : "Send code"}
          </button>
          <a href="/login" className="text-center text-xs text-tertiary hover:text-primary">
            Back to sign in
          </a>
        </form>
      )}

      {phase === "reset" && (
        <form onSubmit={submitReset} className="glass-card flex w-full max-w-sm flex-col gap-4 p-8">
          <h1 className="text-lg font-semibold text-primary">Enter your code</h1>
          {message && <p className="text-xs text-secondary">{message}</p>}
          <input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="6-digit code"
            autoFocus
            className="rounded-lg border border-border bg-background px-3 py-2 text-center text-lg tracking-widest text-primary outline-none focus:border-cyan"
          />
          <input
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            type="password"
            required
            minLength={8}
            placeholder="New password"
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
          />
          {error && <p className="text-sm text-danger">{error}</p>}
          <button
            type="submit"
            disabled={pending || code.length !== 6 || newPassword.length < 8}
            className="rounded-lg bg-cyan px-4 py-2 font-medium text-accent-fg transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {pending ? "Resetting…" : "Reset password"}
          </button>
          <button type="button" onClick={() => setPhase("request")} className="text-xs text-tertiary hover:text-primary">
            Back
          </button>
        </form>
      )}

      {phase === "done" && (
        <div className="glass-card flex w-full max-w-sm flex-col gap-3 p-8 text-center">
          <h1 className="text-lg font-semibold text-primary">Password reset</h1>
          <p className="text-sm text-secondary">Redirecting you to sign in…</p>
        </div>
      )}
    </main>
  );
}
