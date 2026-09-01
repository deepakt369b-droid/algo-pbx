"use client";

import { useEffect, useState } from "react";

// TimelineCallActions (node W, W4) — a drop-in helper for S2b's contact
// Activity timeline. Given a CALL activity's refId (the CDR uniqueId), it
// fetches GET /api/recordings, finds the row for that call, and renders an
// inline <audio> player — or nothing, when the agent isn't entitled to the
// recording, it's hidden, or none exists. The route's own auth (both the
// listing query and the byte-serving endpoint) is the real gate; this only
// renders what it's allowed to see.

interface RecordingRow {
  recordingUrl: string;
  cdr: { uniqueId: string };
}

export function TimelineCallActions({ activityRefId }: { activityRefId: string | null | undefined }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!activityRefId) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    fetch("/api/recordings", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { recordings: [] }))
      .then((data) => {
        if (cancelled) return;
        const rows: RecordingRow[] = data.recordings ?? [];
        const hit = rows.find((r) => r.cdr?.uniqueId === activityRefId);
        setUrl(hit?.recordingUrl ?? null);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [activityRefId]);

  if (!url) return null;

  return (
    <audio
      controls
      preload="none"
      src={url}
      className="mt-1 h-8 w-full max-w-xs"
      aria-label="Call recording"
    />
  );
}
