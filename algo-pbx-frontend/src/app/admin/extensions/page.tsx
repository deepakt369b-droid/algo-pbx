"use client";

import { useEffect, useState } from "react";

type DialPermission = "LOCAL" | "NATIONAL" | "INTERNATIONAL";

interface ExtensionRow {
  id: string;
  number: string;
  kind: string;
  status: string;
  dialPermission: DialPermission;
}

const DIAL_PERMISSION_LABELS: Record<DialPermission, string> = {
  LOCAL: "Local (UAE only)",
  NATIONAL: "National (UAE + India)",
  INTERNATIONAL: "International (everywhere)",
};

export default function ExtensionsPage() {
  const [extensions, setExtensions] = useState<ExtensionRow[]>([]);
  const [number, setNumber] = useState("");
  const [kind, setKind] = useState<"webrtc" | "hardware">("webrtc");
  const [dialPermission, setDialPermission] = useState<DialPermission>("LOCAL");
  const [message, setMessage] = useState<string | null>(null);
  const [permissionSaving, setPermissionSaving] = useState<string | null>(null);
  const [confirmDeleteNumber, setConfirmDeleteNumber] = useState<string | null>(null);
  // sipSecret is only ever available right after creation — the server
  // never returns it again (see GET /api/extensions's comment). Shown once,
  // then gone; the admin must copy it now or regenerate the extension.
  const [revealedSecret, setRevealedSecret] = useState<{ number: string; secret: string; voicemailPin: string | null } | null>(null);

  const load = () => {
    fetch("/api/extensions")
      .then((r) => r.json())
      .then((data) => setExtensions(data.extensions ?? []));
  };

  useEffect(load, []);

  const updatePermission = async (number: string, next: DialPermission) => {
    setPermissionSaving(number);
    setMessage(null);
    try {
      const res = await fetch(`/api/extensions/${number}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dialPermission: next }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMessage(`Failed: ${JSON.stringify(data.error ?? data)}`);
        return;
      }
      if (data.warning) setMessage(data.warning);
      load();
    } finally {
      setPermissionSaving(null);
    }
  };

  const rotateSecret = async (number: string) => {
    if (!confirm(`Rotate the SIP secret for extension ${number}? The current softphone/phone will stop registering until it's given the new secret.`)) return;
    setMessage(null);
    setRevealedSecret(null);
    const res = await fetch(`/api/extensions/${number}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ rotateSecret: true }) });
    const data = await res.json();
    if (res.ok) {
      setRevealedSecret({ number, secret: data.sipSecret, voicemailPin: null });
      setMessage(data.warning ?? `Secret rotated for extension ${number} — copy it now, it won't be shown again.`);
    } else {
      setMessage(`Failed: ${JSON.stringify(data.error ?? data)}`);
    }
  };

  const deleteExtension = async (number: string) => {
    const res = await fetch(`/api/extensions/${number}`, { method: "DELETE" });
    const data = await res.json();
    setConfirmDeleteNumber(null);
    if (res.ok) {
      setMessage(data.warning ?? `Extension ${number} deleted.`);
      load();
    } else {
      setMessage(`Failed: ${JSON.stringify(data.error ?? data)}`);
    }
  };

  const create = async () => {
    setMessage(null);
    setRevealedSecret(null);
    const res = await fetch("/api/extensions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ number, kind, dialPermission }),
    });
    const data = await res.json();
    if (res.ok) {
      setRevealedSecret({ number, secret: data.sipSecret, voicemailPin: data.voicemailPin ?? null });
      setMessage(
        data.warning ??
          (kind === "webrtc"
            ? "Created. The agent's own softphone will fetch this automatically once their user account is linked — you shouldn't normally need to hand out the secret below."
            : "Created and pushed to Asterisk. Copy the secret below into the physical phone's SIP configuration now — it will not be shown again.")
      );
      setNumber("");
      load();
    } else {
      setMessage(`Failed: ${JSON.stringify(data.error ?? data)}`);
    }
  };

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-slate-100">Extension & Trunk Provisioning</h1>

      <div className="glass-card flex w-full max-w-md flex-col gap-3 p-6">
        <input
          value={number}
          onChange={(e) => setNumber(e.target.value)}
          placeholder="Extension number, e.g. 1002"
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
        />
        <div className="flex gap-2">
          <button
            onClick={() => setKind("webrtc")}
            className={`flex-1 rounded-lg border px-2 py-1.5 text-xs ${kind === "webrtc" ? "border-cyan text-cyan" : "border-border text-slate-400"}`}
          >
            WebRTC Agent
          </button>
          <button
            onClick={() => setKind("hardware")}
            className={`flex-1 rounded-lg border px-2 py-1.5 text-xs ${kind === "hardware" ? "border-cyan text-cyan" : "border-border text-slate-400"}`}
          >
            IP Phone
          </button>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-slate-300">Dial permission</label>
          <p className="text-xs text-slate-500">
            Which numbers this extension can dial out to (Loop C2 toll-fraud guard) — defaults to the most
            restrictive tier; widen only if the agent actually needs it.
          </p>
          <select
            value={dialPermission}
            onChange={(e) => setDialPermission(e.target.value as DialPermission)}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
          >
            {(Object.keys(DIAL_PERMISSION_LABELS) as DialPermission[]).map((p) => (
              <option key={p} value={p}>
                {DIAL_PERMISSION_LABELS[p]}
              </option>
            ))}
          </select>
        </div>
        <button onClick={create} className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-background">
          Provision
        </button>
        {message && <p className="text-xs text-slate-500">{message}</p>}
        {revealedSecret && (
          <div className="rounded-lg border border-cyan/40 bg-cyan/5 p-3">
            <p className="text-xs text-slate-400">
              SIP secret for extension {revealedSecret.number} (shown once):
            </p>
            <code className="mt-1 block break-all text-sm text-cyan">{revealedSecret.secret}</code>
            {revealedSecret.voicemailPin && (
              <>
                <p className="mt-2 text-xs text-slate-400">Voicemail PIN (shown once, *97 self-service):</p>
                <code className="mt-1 block text-sm text-cyan">{revealedSecret.voicemailPin}</code>
              </>
            )}
          </div>
        )}
      </div>

      <div className="glass-card w-full max-w-md p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
          Existing Extensions
        </h2>
        {extensions.length === 0 ? (
          <p className="text-slate-500">None yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm text-slate-200">
            {extensions.map((ext) => (
              <li key={ext.id} className="flex flex-col gap-1.5 border-t border-border pt-2 first:border-0 first:pt-0">
                <div className="flex justify-between">
                  <span>{ext.number}</span>
                  <span className="text-slate-500">{ext.kind}</span>
                  <span className="text-slate-500">{ext.status}</span>
                </div>
                <select
                  value={ext.dialPermission}
                  disabled={permissionSaving === ext.number}
                  onChange={(e) => updatePermission(ext.number, e.target.value as DialPermission)}
                  className="w-full rounded-lg border border-border bg-background px-2 py-1 text-xs outline-none focus:border-cyan disabled:opacity-50"
                >
                  {(Object.keys(DIAL_PERMISSION_LABELS) as DialPermission[]).map((p) => (
                    <option key={p} value={p}>
                      {DIAL_PERMISSION_LABELS[p]}
                    </option>
                  ))}
                </select>
                <div className="flex items-center justify-end gap-3 text-xs">
                  <button onClick={() => rotateSecret(ext.number)} className="text-cyan hover:underline">
                    Rotate secret
                  </button>
                  {confirmDeleteNumber === ext.number ? (
                    <>
                      <button onClick={() => deleteExtension(ext.number)} className="text-red-400 hover:text-red-300">
                        Confirm delete
                      </button>
                      <button onClick={() => setConfirmDeleteNumber(null)} className="text-slate-500">
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button onClick={() => setConfirmDeleteNumber(ext.number)} className="text-red-400 hover:text-red-300">
                      Delete
                    </button>
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
