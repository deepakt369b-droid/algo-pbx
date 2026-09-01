"use client";

import { useCallback, useEffect, useState } from "react";
import { Button, Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui";

interface LiveChannel {
  channel: string;
  state: string;
  callerIdNum?: string;
  callerIdName?: string;
  connectedLineNum?: string;
  application?: string;
  duration?: string;
}

export default function MonitorPage() {
  const [channels, setChannels] = useState<LiveChannel[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/monitor");
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load channels");
      setChannels(json.channels ?? []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load channels");
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  async function listen(channel: string) {
    setBusy(channel);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/monitor", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ targetChannel: channel }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "Monitor failed");
      setNotice("Your extension is ringing — answer it to listen in. This is listen-only; the parties can't hear you.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Monitor failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-primary">Live call monitoring</h1>
        <p className="mt-1 text-sm text-secondary">
          Listen in on an active call for QA. Listen-only — no whisper, no barge. Every session is written to the audit log.
        </p>
      </div>

      {error && (
        <div className="rounded-[var(--radius)] border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">{error}</div>
      )}
      {notice && (
        <div className="rounded-[var(--radius)] border border-accent/40 bg-accent/10 px-4 py-3 text-sm text-primary">{notice}</div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Active channels</CardTitle>
          <CardDescription>Refreshes every 5 seconds.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {channels.length === 0 && <p className="text-sm text-tertiary">No active calls.</p>}
          {channels.map((c) => (
            <div
              key={c.channel}
              className="flex items-center justify-between gap-3 rounded-[var(--radius)] border px-3 py-2 [border-color:rgb(var(--hairline))]"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-primary">
                  {c.callerIdName || c.callerIdNum || "?"}
                  {c.connectedLineNum ? ` → ${c.connectedLineNum}` : ""}
                </p>
                <p className="truncate text-[12px] text-tertiary">
                  {c.channel} &middot; {c.state}
                  {c.application ? ` · ${c.application}` : ""}
                </p>
              </div>
              <Button size="sm" variant="secondary" disabled={busy === c.channel} onClick={() => listen(c.channel)}>
                {busy === c.channel ? "Connecting…" : "Listen"}
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
