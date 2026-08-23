"use client";

import { useEffect, useState } from "react";

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  disabled: boolean;
  extension: { number: string; kind: string; status: string } | null;
  invite: { consumedAt: string | null; expiresAt: string } | null;
  phoneE164: string | null;
  phoneVerifiedAt: string | null;
  phoneVerifiedByAdminId: string | null;
  photoPath: string | null;
  profileCompletedAt: string | null;
}

// No password field — POST /api/admin/users creates the account with no
// password at all and sends a single-use Resend invite link instead of an
// admin typing a "temporary password" that was never emailed and never
// rotatable. See that route's file-header comment. Agents cannot change
// their own email or password after accepting the invite — there is no
// route anywhere that would let them.
export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"AGENT" | "SUPERVISOR" | "ADMIN">("AGENT");
  const [extensionNumber, setExtensionNumber] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);

  const load = () => {
    fetch("/api/admin/users")
      .then((r) => r.json())
      .then((data) => setUsers(data.users ?? []));
  };

  useEffect(load, []);

  const create = async () => {
    setMessage(null);
    setRevealedSecret(null);
    const res = await fetch("/api/admin/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        name,
        role,
        extensionNumber: extensionNumber || undefined,
      }),
    });
    const data = await res.json();
    if (res.ok) {
      setMessage(data.warning ?? "User created. An invite email was sent — they'll set their own password there.");
      if (data.sipSecret) setRevealedSecret(data.sipSecret);
      setEmail("");
      setName("");
      setExtensionNumber("");
      load();
    } else {
      setMessage(`Failed: ${JSON.stringify(data.error ?? data)}`);
    }
  };

  const toggleDisabled = async (u: UserRow) => {
    await fetch(`/api/admin/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ disabled: !u.disabled }),
    });
    load();
  };

  // Escape hatch named in the plan: "if the verification is having some
  // glitch the admin will have power to override and give them a
  // verified status." Distinguishable from self-verification via
  // phoneVerifiedByAdminId (set here, null on a real OTP round-trip) —
  // see api/admin/users/[id]/route.ts's comment.
  const overridePhoneVerification = async (u: UserRow) => {
    if (!confirm(`Mark ${u.phoneE164} as verified for ${u.name}? This bypasses OTP verification.`)) return;
    await fetch(`/api/admin/users/${u.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ verifyPhoneOverride: true }),
    });
    load();
  };

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-slate-100">User &amp; Agent Management</h1>

      <div className="glass-card flex w-full max-w-md flex-col gap-3 p-6">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Full name"
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
        />
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          type="email"
          placeholder="Email (this becomes their username)"
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
        />
        <div className="flex gap-2">
          {(["AGENT", "SUPERVISOR", "ADMIN"] as const).map((r) => (
            <button
              key={r}
              onClick={() => setRole(r)}
              className={`flex-1 rounded-lg border px-2 py-1.5 text-xs ${role === r ? "border-cyan text-cyan" : "border-border text-slate-400"}`}
            >
              {r}
            </button>
          ))}
        </div>
        <input
          value={extensionNumber}
          onChange={(e) => setExtensionNumber(e.target.value)}
          placeholder="Extension to link, e.g. 1002 (optional — agents need one to take calls)"
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
        />
        <button onClick={create} className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-background">
          Create User &amp; Send Invite
        </button>
        {message && <p className="text-xs text-slate-500">{message}</p>}
        {revealedSecret && (
          <div className="rounded-lg border border-cyan/40 bg-cyan/5 p-3">
            <p className="text-xs text-slate-400">
              SIP secret for the linked extension (shown once — the agent&apos;s own softphone fetches this automatically, you shouldn&apos;t normally need it):
            </p>
            <code className="mt-1 block break-all text-sm text-cyan">{revealedSecret}</code>
          </div>
        )}
      </div>

      <div className="glass-card w-full max-w-md p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
          Existing Users
        </h2>
        {users.length === 0 ? (
          <p className="text-slate-500">None yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm text-slate-200">
            {users.map((u) => (
              <li key={u.id} className="flex gap-3 border-t border-border pt-2 first:border-0 first:pt-0">
                {u.photoPath ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={`/api/me/photo/${u.id}`} alt="" className="h-10 w-10 flex-shrink-0 rounded-full object-cover" />
                ) : (
                  <div className="h-10 w-10 flex-shrink-0 rounded-full bg-surface" />
                )}
                <div className="flex flex-1 flex-col">
                  <div className="flex justify-between">
                    <span className={u.disabled ? "text-slate-500 line-through" : ""}>{u.name}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-500">{u.role}</span>
                      <button
                        onClick={() => toggleDisabled(u)}
                        className={`text-xs ${u.disabled ? "text-green-400 hover:text-green-300" : "text-red-400 hover:text-red-300"}`}
                      >
                        {u.disabled ? "Enable" : "Disable"}
                      </button>
                    </div>
                  </div>
                  <div className="flex justify-between text-xs text-slate-500">
                    <span>{u.email}</span>
                    <span>{u.extension ? `ext. ${u.extension.number} (${u.extension.status})` : "no extension"}</span>
                  </div>
                  {u.invite && !u.invite.consumedAt && (
                    <p className="text-xs text-yellow-500">
                      Invite pending{new Date(u.invite.expiresAt) < new Date() ? " (expired)" : ""}
                    </p>
                  )}
                  {u.role === "AGENT" && u.invite?.consumedAt && (
                    <div className="mt-1 flex items-center justify-between text-xs">
                      <span className={u.profileCompletedAt ? "text-green-400" : "text-yellow-500"}>
                        {u.profileCompletedAt
                          ? "Registration complete"
                          : u.phoneE164
                            ? u.phoneVerifiedAt
                              ? "Registered, phone verified"
                              : "Registered — phone not verified"
                            : "Registration not started"}
                        {u.phoneVerifiedByAdminId && " (admin-verified)"}
                      </span>
                      {u.phoneE164 && !u.phoneVerifiedAt && (
                        <button onClick={() => overridePhoneVerification(u)} className="text-cyan hover:underline">
                          Verify manually
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
