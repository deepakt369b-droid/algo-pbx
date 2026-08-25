"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

// The one and only place an agent ever sets their own password — exactly
// once, via a single-use token an admin's invite email delivered. There is
// no equivalent page reachable after this succeeds (see
// src/app/api/invite/route.ts's header for why that's a hard requirement,
// not an oversight).
export default function InvitePage({ params }: { params: { token: string } }) {
  const router = useRouter();
  const [status, setStatus] = useState<"loading" | "valid" | "invalid" | "done">("loading");
  const [email, setEmail] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    fetch(`/api/invite?token=${encodeURIComponent(params.token)}`)
      .then((r) => r.json())
      .then((data) => {
        if (data.valid) {
          setEmail(data.email);
          setStatus("valid");
        } else {
          setStatus("invalid");
        }
      })
      .catch(() => setStatus("invalid"));
  }, [params.token]);

  const submit = async () => {
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
      const res = await fetch("/api/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: params.token, password }),
      });
      const data = await res.json();
      if (res.ok) {
        setStatus("done");
        setTimeout(() => router.push("/login"), 2000);
      } else {
        setError(data.error ?? "Something went wrong.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background p-8">
      <div className="glass-card w-full max-w-sm p-6">
        <h1 className="mb-4 text-lg font-semibold text-slate-100">Set your password</h1>

        {status === "loading" && <p className="text-sm text-slate-400">Checking invite link...</p>}

        {status === "invalid" && (
          <p className="text-sm text-red-400">
            This invite link is invalid or has expired. Ask an administrator to send a new one.
          </p>
        )}

        {status === "valid" && (
          <div className="flex flex-col gap-3">
            <p className="text-sm text-slate-400">
              Account: <span className="text-slate-200">{email}</span>
            </p>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="New password (min 8 characters)"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
            />
            <input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Confirm password"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
            />
            {error && <p className="text-xs text-red-400">{error}</p>}
            <button
              onClick={submit}
              disabled={submitting}
              className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
            >
              Set password
            </button>
            <p className="text-xs text-slate-600">
              This link can only be used once. Your email address is your username and cannot be
              changed by you — contact an administrator if it needs to change.
            </p>
          </div>
        )}

        {status === "done" && (
          <p className="text-sm text-green-400">Password set. Redirecting to sign in...</p>
        )}
      </div>
    </main>
  );
}
