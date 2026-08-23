"use client";

import { useEffect, useState } from "react";

interface SignInEvent {
  id: string;
  createdAt: string;
  user: { id: string; name: string; email: string; role: string } | null;
  metadata: { ip?: string; userAgent?: string; newDevice?: boolean } | null;
}

// Admin-visible feed of every successful sign-in, written by
// src/auth.ts's authorize() as an AuditLog row. Polls every 5s (this
// codebase's standard "realtime" pattern — see src/components/
// wallboard.tsx). New-device sign-ins are highlighted; the unread badge
// clears when this page is viewed (POST marks signInFeedSeenAt).
export default function SignInsPage() {
  const [events, setEvents] = useState<SignInEvent[]>([]);
  const [lastSeenAt, setLastSeenAt] = useState<string | null>(null);

  useEffect(() => {
    const load = () => {
      fetch("/api/admin/sign-ins")
        .then((r) => r.json())
        .then((data) => {
          setEvents(data.events ?? []);
          setLastSeenAt((prev) => prev ?? data.lastSeenAt);
        });
    };
    load();
    const interval = setInterval(load, 5000);
    fetch("/api/admin/sign-ins", { method: "POST" });
    return () => clearInterval(interval);
  }, []);

  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-slate-100">Sign-In Activity</h1>

      <div className="glass-card w-full max-w-2xl p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-400">
          Recent sign-ins ({events.length})
        </h2>
        {events.length === 0 ? (
          <p className="text-slate-500">None yet.</p>
        ) : (
          <ul className="flex flex-col gap-2 text-sm text-slate-200">
            {events.map((e) => {
              const isUnread = lastSeenAt ? new Date(e.createdAt) > new Date(lastSeenAt) : false;
              return (
                <li key={e.id} className="flex items-center justify-between border-t border-border pt-2 first:border-0 first:pt-0">
                  <div className="flex items-center gap-2">
                    {isUnread && <span className="h-2 w-2 rounded-full bg-cyan" title="New since your last visit" />}
                    <div>
                      <p>
                        {e.user?.name ?? "Unknown"} <span className="text-xs text-slate-500">({e.user?.role})</span>
                      </p>
                      <p className="text-xs text-slate-500">
                        {e.metadata?.ip ?? "unknown IP"} · {new Date(e.createdAt).toLocaleString()}
                      </p>
                    </div>
                  </div>
                  {e.metadata?.newDevice && (
                    <span className="rounded bg-yellow-500/10 px-2 py-0.5 text-xs text-yellow-400">New device</span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
