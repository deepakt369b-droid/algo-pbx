"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";

// Single-phase login form, unlike src/app/login/login-form.tsx's two-phase
// credentials -> OTP flow. That two-phase shape exists there because
// WhatsApp OTP has to be SENT before it can be verified; TOTP needs no
// delivery step — the operator already has the code in their authenticator
// app before they ever load this page — so email + password + code all
// submit together in one signIn() call. platform-auth.ts's authorize()
// checks password and TOTP together server-side.
function safeCallbackUrl(callbackUrl: string | undefined): string {
  if (callbackUrl && callbackUrl.startsWith("/") && !callbackUrl.startsWith("//")) {
    return callbackUrl;
  }
  return "/platform";
}

export function PlatformLoginForm({ callbackUrl }: { callbackUrl?: string }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      // Uses next-auth/react's signIn, but note this app has TWO NextAuth
      // instances — this call must hit the platform one, not the tenant
      // one. That routing happens by cookie/route, not by which client
      // helper is imported (both `/api/auth/*` and `/api/platform-auth/*`
      // aren't distinct here — see the route handler at
      // src/app/api/platform-auth/[...nextauth]/route.ts, which wires
      // next-auth/react's default basePath to the platform instance's
      // handlers for pages under /platform).
      const result = await signIn("credentials", {
        email,
        password,
        code,
        redirect: false,
        // next-auth/react defaults to POSTing /api/auth/callback/credentials;
        // the platform instance's route handlers live under
        // /api/platform-auth instead (see that route file's comment), so
        // basePath here is required, not cosmetic.
        basePath: "/api/platform-auth",
      });
      if (result?.error) {
        setError("Invalid email, password, or code.");
        return;
      }
      router.push(safeCallbackUrl(callbackUrl));
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="glass-card flex w-full max-w-sm flex-col gap-4 p-8">
      <h1 className="text-lg font-semibold text-primary">Algo PBX Platform</h1>
      <p className="text-xs text-tertiary">Owner console sign-in. TOTP is required for every account.</p>
      <input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        type="email"
        required
        placeholder="you@algopbx.internal"
        autoComplete="username"
        className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
      />
      <input
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        type="password"
        required
        minLength={8}
        placeholder="Password"
        autoComplete="current-password"
        className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
      />
      <input
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        placeholder="6-digit authenticator code"
        inputMode="numeric"
        autoComplete="one-time-code"
        required
        className="rounded-lg border border-border bg-background px-3 py-2 text-center text-lg tracking-widest text-primary outline-none focus:border-cyan"
      />
      {error && <p className="text-sm text-danger">{error}</p>}
      <button
        type="submit"
        disabled={pending || code.length !== 6}
        className="rounded-lg bg-cyan px-4 py-2 font-medium text-accent-fg transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
