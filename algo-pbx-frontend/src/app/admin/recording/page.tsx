"use client";

import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription, Switch } from "@/components/ui";

interface Flags {
  recordingEnabled: boolean;
  announcementEnabled: boolean;
}

export default function RecordingSettingsPage() {
  const [flags, setFlags] = useState<Flags | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/recording")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Failed to load"))))
      .then(setFlags)
      .catch((e) => setError(e.message));
  }, []);

  async function patch(body: Partial<Flags>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/recording", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : "Update failed");
      setFlags(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-primary">Call recording</h1>
        <p className="mt-1 text-sm text-secondary">
          Global switch for recording every inbound and outbound call. Takes effect on the next call — no restart.
        </p>
      </div>

      {error && (
        <div className="rounded-[var(--radius)] border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Recording</CardTitle>
          <CardDescription>
            When on, all calls are recorded and stored under Telephony &rarr; Recordings. When a call is recorded,
            callers are always played the recording declaration.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <Switch
            label="Record all calls"
            checked={flags?.recordingEnabled ?? false}
            disabled={!flags || busy}
            onChange={(v) => patch({ recordingEnabled: v })}
          />
          <Switch
            label='Play "this call may be recorded" to callers'
            checked={flags?.announcementEnabled ?? false}
            disabled={!flags || busy || (flags?.recordingEnabled ?? false)}
            onChange={(v) => patch({ announcementEnabled: v })}
          />
          {flags?.recordingEnabled && (
            <p className="text-[13px] text-tertiary">
              The declaration is locked on while recording is on — you may not record callers silently.
            </p>
          )}
        </CardContent>
      </Card>

      <p className="text-[13px] text-tertiary">
        If the database is unreachable, the dialplan fails open: calls are recorded and the declaration is played.
        Recording only stops after this switch is turned off successfully.
      </p>
    </div>
  );
}
