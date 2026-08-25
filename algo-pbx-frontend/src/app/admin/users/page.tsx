"use client";

import { useEffect, useState } from "react";
import { apiFetch, ApiError } from "@/lib/client/api";

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: string;
  disabled: boolean;
  extension: { number: string; kind: string; status: string } | null;
  waInstance: { id: string; label: string; simPort: number; status: string; phoneE164: string | null } | null;
  invite: { consumedAt: string | null; expiresAt: string } | null;
  phoneE164: string | null;
  phoneVerifiedAt: string | null;
  phoneVerifiedByAdminId: string | null;
  photoPath: string | null;
  profileCompletedAt: string | null;
}

interface WaInstanceOption {
  id: string;
  label: string;
  simPort: number;
  assignedUser: { id: string } | null;
}

// Two account-creation paths, admin's choice: "Invite" (original flow —
// no password set here, a Resend link lets the agent set their own) or
// "Set password now" (admin types email + password + phone directly, no
// email round-trip — see POST /api/admin/users's header for why both
// exist). Either path can also allocate an extension and a WhatsApp SIM
// port in the same request.
export default function UsersPage() {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [waInstances, setWaInstances] = useState<WaInstanceOption[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [mode, setMode] = useState<"invite" | "password">("invite");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"AGENT" | "SUPERVISOR" | "ADMIN">("AGENT");
  const [password, setPassword] = useState("");
  const [phone, setPhone] = useState("");
  const [extensionMode, setExtensionMode] = useState<"auto" | "manual" | "none">("auto");
  const [extensionNumber, setExtensionNumber] = useState("");
  const [simPort, setSimPort] = useState<number | "">("");
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageKind, setMessageKind] = useState<"ok" | "error">("ok");
  const [revealed, setRevealed] = useState<{ sipSecret?: string; voicemailPin?: string; inviteUrl?: string } | null>(null);

  const load = async () => {
    try {
      const [u, w] = await Promise.all([
        apiFetch<{ users: UserRow[] }>("/api/admin/users"),
        apiFetch<{ instances: WaInstanceOption[] }>("/api/admin/whatsapp/instances"),
      ]);
      setUsers(u.users ?? []);
      setWaInstances(w.instances ?? []);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : "Could not load users.");
    }
  };

  useEffect(() => {
    load();
  }, []);

  const freePorts = waInstances.filter((w) => !w.assignedUser);

  const create = async () => {
    setCreating(true);
    setMessage(null);
    setRevealed(null);
    try {
      const data = await apiFetch<{ warning?: string; sipSecret?: string; voicemailPin?: string; inviteUrl?: string }>(
        "/api/admin/users",
        {
          method: "POST",
          body: {
            email,
            name,
            role,
            password: mode === "password" ? password : undefined,
            phoneE164: mode === "password" && phone ? phone : undefined,
            autoExtension: extensionMode === "auto",
            extensionNumber: extensionMode === "manual" ? extensionNumber : undefined,
            simPort: simPort === "" ? undefined : simPort,
          },
        }
      );
      setMessageKind("ok");
      setMessage(
        data.warning ??
          (mode === "invite" ? "User created. An invite email was sent — they'll set their own password there." : "User created.")
      );
      if (data.sipSecret || data.voicemailPin || data.inviteUrl) {
        setRevealed({ sipSecret: data.sipSecret, voicemailPin: data.voicemailPin, inviteUrl: data.inviteUrl });
      }
      setEmail("");
      setName("");
      setPassword("");
      setPhone("");
      setExtensionNumber("");
      setSimPort("");
      load();
    } catch (err) {
      setMessageKind("error");
      setMessage(err instanceof ApiError ? err.message : "Could not create user.");
    } finally {
      setCreating(false);
    }
  };

  const toggleDisabled = async (u: UserRow) => {
    try {
      const data = await apiFetch<{ warning?: string }>(`/api/admin/users/${u.id}`, {
        method: "PATCH",
        body: { disabled: !u.disabled },
      });
      setMessageKind(data.warning ? "error" : "ok");
      setMessage(data.warning ?? `${u.name} ${u.disabled ? "enabled" : "disabled"}.`);
      load();
    } catch (err) {
      setMessageKind("error");
      setMessage(err instanceof ApiError ? err.message : "Could not update this account.");
    }
  };

  const overridePhoneVerification = async (u: UserRow) => {
    if (!confirm(`Mark ${u.phoneE164} as verified for ${u.name}? This bypasses OTP verification.`)) return;
    try {
      await apiFetch(`/api/admin/users/${u.id}`, { method: "PATCH", body: { verifyPhoneOverride: true } });
      load();
    } catch (err) {
      setMessageKind("error");
      setMessage(err instanceof ApiError ? err.message : "Could not verify this number.");
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-slate-100">User &amp; Agent Management</h1>

      {loadError && (
        <div className="w-full max-w-md rounded-lg border border-red-900 bg-red-950/40 px-4 py-2 text-center text-xs text-red-300">
          {loadError}
        </div>
      )}

      <div className="glass-card flex w-full max-w-md flex-col gap-3 p-6">
        <div className="flex gap-2 text-xs">
          <button
            onClick={() => setMode("invite")}
            className={`flex-1 rounded-lg border px-2 py-1.5 ${mode === "invite" ? "border-cyan text-cyan" : "border-border text-slate-400"}`}
          >
            Email invite
          </button>
          <button
            onClick={() => setMode("password")}
            className={`flex-1 rounded-lg border px-2 py-1.5 ${mode === "password" ? "border-cyan text-cyan" : "border-border text-slate-400"}`}
          >
            Set password now
          </button>
        </div>

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

        {mode === "password" && (
          <>
            <input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              type="text"
              placeholder="Password (min 12 characters)"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
            />
            <input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="Phone, e.g. +971544887712 (optional)"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
            />
          </>
        )}

        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">Extension</p>
          <div className="flex gap-2 text-xs">
            {(["auto", "manual", "none"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setExtensionMode(m)}
                className={`flex-1 rounded-lg border px-2 py-1.5 ${extensionMode === m ? "border-cyan text-cyan" : "border-border text-slate-400"}`}
              >
                {m === "auto" ? "Auto-assign" : m === "manual" ? "Choose number" : "None"}
              </button>
            ))}
          </div>
          {extensionMode === "manual" && (
            <input
              value={extensionNumber}
              onChange={(e) => setExtensionNumber(e.target.value)}
              placeholder="e.g. 1002"
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
            />
          )}
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-slate-500">WhatsApp SIM port</p>
          <select
            value={simPort}
            onChange={(e) => setSimPort(e.target.value ? Number(e.target.value) : "")}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
          >
            <option value="">No WhatsApp port for this agent</option>
            {freePorts.map((w) => (
              <option key={w.id} value={w.simPort}>
                SIM {w.simPort} — {w.label}
              </option>
            ))}
          </select>
          {freePorts.length === 0 && waInstances.length > 0 && (
            <p className="text-xs text-slate-600">All 4 SIM ports are assigned — this agent will be calls-only.</p>
          )}
          {waInstances.length === 0 && (
            <p className="text-xs text-slate-600">
              No WhatsApp instances paired yet — pair one in <span className="text-slate-400">/admin/whatsapp</span> first.
            </p>
          )}
        </div>

        <button
          onClick={create}
          disabled={creating || !email.trim() || !name.trim() || (mode === "password" && password.length < 12)}
          className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          {creating ? "Creating…" : "Create user"}
        </button>
        {message && <p className={`text-xs ${messageKind === "error" ? "text-red-400" : "text-slate-500"}`}>{message}</p>}
        {revealed && (
          <div className="rounded-lg border border-cyan/40 bg-cyan/5 p-3 text-xs">
            <p className="mb-1 text-slate-400">Shown once — save it now:</p>
            {revealed.inviteUrl && (
              <p className="mb-1">
                Invite link: <code className="break-all text-cyan">{revealed.inviteUrl}</code>
              </p>
            )}
            {revealed.sipSecret && (
              <p className="mb-1">
                SIP secret: <code className="break-all text-cyan">{revealed.sipSecret}</code>
              </p>
            )}
            {revealed.voicemailPin && (
              <p>
                Voicemail PIN: <code className="text-cyan">{revealed.voicemailPin}</code>
              </p>
            )}
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
                  {u.waInstance && (
                    <p className="text-xs text-slate-500">
                      WhatsApp: SIM {u.waInstance.simPort} · {u.waInstance.status}
                      {u.waInstance.phoneE164 ? ` · ${u.waInstance.phoneE164}` : ""}
                    </p>
                  )}
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
