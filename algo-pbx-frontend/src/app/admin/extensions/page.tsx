"use client";

import { useEffect, useState } from "react";

interface ExtensionRow {
  id: string;
  number: string;
  kind: string;
  status: string;
}

export default function ExtensionsPage() {
  const [extensions, setExtensions] = useState<ExtensionRow[]>([]);
  const [number, setNumber] = useState("");
  const [kind, setKind] = useState<"webrtc" | "hardware">("webrtc");
  const [message, setMessage] = useState<string | null>(null);
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

  const create = async () => {
    setMessage(null);
    setRevealedSecret(null);
    const res = await fetch("/api/extensions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ number, kind }),
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
              <li key={ext.id} className="flex justify-between border-t border-border pt-2 first:border-0 first:pt-0">
                <span>{ext.number}</span>
                <span className="text-slate-500">{ext.kind}</span>
                <span className="text-slate-500">{ext.status}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
