"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";

// First-run setup wizard — see src/app/api/setup/route.ts's header for
// the full reasoning. Reachable only while no ADMIN account exists;
// GET /api/setup is checked on mount and this page redirects to /login
// immediately if setup is already done, mirroring the server-side check
// that route itself enforces (this client check is a UX convenience,
// not the security boundary — POST /api/setup refuses regardless of
// what this page does).
export default function SetupPage() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);
  const [settingsKeyMissing, setSettingsKeyMissing] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    fetch("/api/setup")
      .then((r) => r.json())
      .then((data) => {
        if (!data.needsSetup) {
          router.replace("/login");
          return;
        }
        setSettingsKeyMissing(!data.settingsKeyConfigured);
        setChecking(false);
      })
      .catch(() => setChecking(false));
  }, [router]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Setup failed.");
        return;
      }
      setDone(true);
      // Sign in immediately and head to the settings page — the natural
      // next step is configuring the services this admin will need.
      await signIn("credentials", { email, password, redirect: false });
      router.push("/admin/settings");
    } finally {
      setSubmitting(false);
    }
  };

  if (checking) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-sm text-slate-400">Checking setup status...</p>
      </main>
    );
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-8">
      <div className="glass-card w-full max-w-sm p-8">
        <h1 className="mb-1 text-lg font-semibold text-slate-100">Welcome to Algo PBX</h1>
        <p className="mb-4 text-xs text-slate-500">Create the first administrator account to get started.</p>

        {settingsKeyMissing && (
          <div className="mb-4 rounded-lg border border-red-500/40 bg-red-500/5 p-3">
            <p className="text-xs text-red-400">
              SETTINGS_ENCRYPTION_KEY is not set. Generate one with{" "}
              <code className="text-red-300">openssl rand -hex 32</code>, add it to your <code>.env</code>, and
              restart the container before continuing — runtime settings (Resend, WhatsApp, etc.) can&apos;t be
              stored without it.
            </p>
          </div>
        )}

        {!done ? (
          <form onSubmit={submit} className="flex flex-col gap-3">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              required
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
            />
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              type="email"
              placeholder="Admin email (this becomes your username)"
              required
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
            />
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="password"
              placeholder="Password (min 8 characters)"
              required
              minLength={8}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
            />
            <input
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              type="password"
              placeholder="Confirm password"
              required
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
            />
            {error && <p className="text-xs text-red-400">{error}</p>}
            <button
              type="submit"
              disabled={submitting || settingsKeyMissing}
              className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
            >
              {submitting ? "Creating..." : "Create admin account"}
            </button>
          </form>
        ) : (
          <p className="text-sm text-green-400">Admin account created. Signing you in...</p>
        )}
      </div>
    </main>
  );
}
