"use client";

import { useEffect, useState } from "react";

const MODES = [
  { value: "listen", label: "Listen (Eavesdrop)" },
  { value: "whisper", label: "Whisper (Coach)" },
  { value: "barge", label: "Barge (Join)" },
] as const;

interface LiveChannel {
  channel: string;
  state?: string;
  callerIdNum?: string;
  application?: string;
}

// Supervisor live-call intervention. Now backed by GET /api/channels (built
// on the AMI multi-event collector, src/lib/ami-client.ts) instead of
// requiring the supervisor to read the agent's channel name off
// `asterisk -rx "core show channels"` by hand. The dropdown degrades to a
// manual text field if the channel list fails to load (e.g. AMI down) so
// the feature isn't a hard dependency on this one extra call succeeding.
export function InterventionControls({ supervisorExtension }: { supervisorExtension: string }) {
  const [channels, setChannels] = useState<LiveChannel[] | null>(null);
  const [targetChannel, setTargetChannel] = useState("");
  const [mode, setMode] = useState<(typeof MODES)[number]["value"]>("listen");
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/channels")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data) => {
        if (!cancelled) setChannels(data.channels ?? []);
      })
      .catch(() => {
        if (!cancelled) setChannels(null); // falls back to manual entry below
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const trigger = async () => {
    if (!targetChannel) return;
    setStatus("Sending…");
    try {
      const res = await fetch("/api/intervention", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ supervisorExtension, targetChannel, mode }),
      });
      setStatus(res.ok ? "Intervention originated" : "Failed — check AMI connection");
    } catch {
      setStatus("Failed — network error");
    }
  };

  return (
    <div className="glass-card flex w-full max-w-md flex-col gap-3 p-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-secondary">
        Live Call Intervention
      </h2>
      {channels ? (
        <select
          value={targetChannel}
          onChange={(e) => setTargetChannel(e.target.value)}
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
        >
          <option value="">Select a live channel…</option>
          {channels.map((c) => (
            <option key={c.channel} value={c.channel}>
              {c.channel} {c.callerIdNum ? `— ${c.callerIdNum}` : ""} {c.state ? `(${c.state})` : ""}
            </option>
          ))}
        </select>
      ) : (
        <input
          value={targetChannel}
          onChange={(e) => setTargetChannel(e.target.value)}
          placeholder="Agent channel, e.g. PJSIP/1001-00000001 (channel list unavailable)"
          className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
        />
      )}
      <div className="flex gap-2">
        {MODES.map((m) => (
          <button
            key={m.value}
            onClick={() => setMode(m.value)}
            className={`flex-1 rounded-lg border px-2 py-1.5 text-xs ${
              mode === m.value ? "border-cyan text-cyan" : "border-border text-secondary"
            }`}
          >
            {m.label}
          </button>
        ))}
      </div>
      <button onClick={trigger} className="rounded-lg bg-blue px-4 py-2 text-sm font-medium text-primary">
        Start
      </button>
      {status && <p className="text-xs text-tertiary">{status}</p>}
    </div>
  );
}
