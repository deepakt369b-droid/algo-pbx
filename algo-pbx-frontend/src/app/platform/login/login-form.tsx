"use client";

import { useState } from "react";
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
  const [showPassword, setShowPassword] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      // Deliberately NOT next-auth/react's signIn(): this app has TWO
      // NextAuth instances, and signIn() targets a single global
      // `__NEXTAUTH.basePath` set by whichever <SessionProvider> last
      // rendered — it has no per-call basePath override despite appearing
      // to accept one in its options object (that value silently gets
      // absorbed into the POST body instead). Since the root layout's
      // tenant-plane <AuthSessionProvider> sets that global to `/api/auth`,
      // signIn() here would always POST to the TENANT credentials
      // endpoint, never the platform one — confirmed live via a browser
      // network trace, not a hunch. Posting to `/api/platform-auth/*`
      // directly sidesteps that shared global entirely.
      const csrfRes = await fetch("/api/platform-auth/csrf");
      const { csrfToken } = await csrfRes.json();
      const res = await fetch("/api/platform-auth/callback/credentials", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Auth-Return-Redirect": "1",
        },
        body: new URLSearchParams({ email, password, code, csrfToken, callbackUrl: safeCallbackUrl(callbackUrl) }),
      });
      const data = await res.json();
      const errorParam = data?.url ? new URL(data.url).searchParams.get("error") : "1";
      if (!res.ok || errorParam) {
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
      <div className="relative">
        <input
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          type={showPassword ? "text" : "password"}
          required
          minLength={8}
          placeholder="Password"
          autoComplete="current-password"
          className="w-full rounded-lg border border-border bg-background px-3 py-2 pr-16 text-sm text-primary outline-none focus:border-cyan"
        />
        <button
          type="button"
          onClick={() => setShowPassword((v) => !v)}
          tabIndex={-1}
          className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-tertiary hover:text-secondary"
        >
          {showPassword ? "Hide" : "Show"}
        </button>
      </div>
      <input
        value={code}
        onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
        placeholder="6-digit authenticator code (leave blank if not yet enrolled)"
        inputMode="numeric"
        autoComplete="one-time-code"
        className="rounded-lg border border-border bg-background px-3 py-2 text-center text-lg tracking-widest text-primary outline-none focus:border-cyan"
      />
      {error && <p className="text-sm text-danger">{error}</p>}
      <button
        type="submit"
        disabled={pending || (code.length > 0 && code.length !== 6)}
        className="rounded-lg bg-cyan px-4 py-2 font-medium text-accent-fg transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {pending ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
