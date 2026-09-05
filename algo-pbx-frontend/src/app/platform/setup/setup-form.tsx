"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// Two forced steps, shown one at a time. Each step's success handler calls
// router.refresh() to re-run the server component (platform/setup/page.tsx)
// rather than navigating client-side — that's what re-evaluates
// requirePlatformSetupSession() and either advances to the next step or,
// once both are done, redirects to /platform.
export function PlatformSetupForm({
  needsPasswordChange,
  needsTotp,
  otpauthUri,
}: {
  needsPasswordChange: boolean;
  needsTotp: boolean;
  otpauthUri: string | null;
}) {
  if (needsPasswordChange) {
    return <PasswordStep />;
  }
  return <TotpStep otpauthUri={otpauthUri} />;
}

function PasswordStep() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password !== confirm) {
      setError("Passwords don't match.");
      return;
    }
    setPending(true);
    try {
      const res = await fetch("/api/platform/setup/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Could not set the new password.");
        return;
      }
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="glass-card flex w-full max-w-sm flex-col gap-4 p-8">
      <h1 className="text-lg font-semibold text-primary">Set a new password</h1>
      <p className="text-xs text-tertiary">
        This account was created with a one-time password. Choose a new one before continuing.
      </p>
      <input
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        type="password"
        required
        minLength={12}
        placeholder="New password (min. 12 characters)"
        autoComplete="new-password"
        className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
      />
      <input
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        type="password"
        required
        minLength={12}
        placeholder="Confirm new password"
        autoComplete="new-password"
        className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-primary outline-none focus:border-cyan"
      />
      {error && <p className="text-sm text-danger">{error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-cyan px-4 py-2 font-medium text-accent-fg transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {pending ? "Saving…" : "Set password"}
      </button>
    </form>
  );
}

function TotpStep({ otpauthUri }: { otpauthUri: string | null }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setPending(true);
    try {
      const res = await fetch("/api/platform/setup/totp/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Invalid code.");
        return;
      }
      router.push("/platform");
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  };

  return (
    <form onSubmit={submit} className="glass-card flex w-full max-w-md flex-col gap-4 p-8">
      <h1 className="text-lg font-semibold text-primary">Set up your authenticator</h1>
      <p className="text-xs text-tertiary">
        Add this to an authenticator app (scan the URI below as a QR code via any otpauth:// → QR
        tool, or use its <code>secret=</code> parameter for manual entry), then enter a live code.
      </p>
      {otpauthUri && (
        <textarea
          readOnly
          value={otpauthUri}
          rows={3}
          onFocus={(e) => e.currentTarget.select()}
          className="rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs text-secondary outline-none"
        />
      )}
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
        {pending ? "Confirming…" : "Confirm and finish setup"}
      </button>
    </form>
  );
}
