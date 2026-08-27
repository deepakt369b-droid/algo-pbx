"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSIP } from "@/contexts/sip-context";

const BASE_TITLE = "Algo PBX — Agent Workspace";

// Small, independent polls purely for the header badge counts — each of
// these already has its own consumer further down the page (AgentVoicemail,
// AgentMissedCalls, the chat panel), which keeps its own state; this is a
// deliberately separate, lightweight fetch rather than prop-drilling state
// up through layout/page boundaries. Reuses existing endpoints — no new
// plumbing for the badges themselves. Before this, none of these three
// were visible anywhere without opening the relevant panel: a backgrounded
// tab or an agent who didn't scroll down had no idea there was unread
// work waiting.
function useBadgeCount(url: string, extract: (data: unknown) => number, intervalMs = 20000): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(url, { cache: "no-store" })
        .then((r) => (r.ok ? r.json() : null))
        .then((data) => {
          if (!cancelled && data) setCount(extract(data));
        })
        .catch(() => undefined);
    };
    load();
    const interval = setInterval(load, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // extract is a stable function literal at each call site below, not
    // expected to change identity in a way that matters here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, intervalMs]);
  return count;
}

function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="ml-1 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-cyan px-1 text-[10px] font-semibold text-background">
      {count > 99 ? "99+" : count}
    </span>
  );
}

// Thin top bar for /agent — no sidebar (this is a single-page softphone
// workspace, unlike the admin section's many pages), just the chrome that
// was completely absent before: sign-out, and a visible connection
// indicator for state (`isConnected`) that sip-context.tsx already tracked
// but nothing ever rendered.
export function AgentShell({
  children,
  userEmail,
  role,
  signOutAction,
}: {
  children: React.ReactNode;
  userEmail?: string | null;
  role?: "AGENT" | "SUPERVISOR" | "ADMIN";
  signOutAction: () => Promise<void>;
}) {
  const { isConnected, callState } = useSIP();

  const voicemailCount = useBadgeCount("/api/voicemail", (d) => (d as { messages?: unknown[] }).messages?.length ?? 0);
  const missedCallsCount = useBadgeCount("/api/me/missed-calls", (d) => {
    const { calls, lastSeenAt } = d as { calls?: { startedAt: string }[]; lastSeenAt?: string | null };
    if (!calls) return 0;
    return lastSeenAt ? calls.filter((c) => new Date(c.startedAt) > new Date(lastSeenAt)).length : calls.length;
  });
  const whatsappUnreadCount = useBadgeCount("/api/messaging/conversations", (d) => {
    const { conversations } = d as { conversations?: { unreadCount: number }[] };
    return (conversations ?? []).reduce((sum, c) => sum + c.unreadCount, 0);
  });

  // Tab-title badge extended to include the aggregate unread total once
  // this data is in scope, not just the ringing state above.
  const unreadTotal = voicemailCount + missedCallsCount + whatsappUnreadCount;

  // Ask once, on first mount of the workspace — never re-prompt on every
  // render/status change. A denial or dismissal just means the browser
  // Notification alert (sip-context.tsx's onCallReceived) silently no-ops
  // on future calls; the audible ringtone is unaffected either way.
  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window && Notification.permission === "default") {
      void Notification.requestPermission();
    }
  }, []);

  // Tab-title badge — before this, a backgrounded/inactive tab gave zero
  // indication a call was ringing (see sip-context.tsx's ringtone comment
  // for the same "nothing in this codebase alerted an agent" gap).
  useEffect(() => {
    if (callState === "ringing") {
      document.title = "☎ Incoming call — Algo PBX";
    } else {
      document.title = unreadTotal > 0 ? `(${unreadTotal > 99 ? "99+" : unreadTotal}) ${BASE_TITLE}` : BASE_TITLE;
    }
    return () => {
      document.title = BASE_TITLE;
    };
  }, [callState, unreadTotal]);

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background/80 px-6 py-3 backdrop-blur">
        <span className="text-sm font-semibold text-slate-100">Algo PBX — Agent Workspace</span>
        <span
          className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs"
          title={isConnected ? "Softphone registered" : "Softphone not connected — you cannot receive calls"}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${isConnected ? "bg-green-400" : "bg-red-400"}`} />
          <span className={isConnected ? "text-green-400" : "text-red-400"}>{isConnected ? "Connected" : "Disconnected"}</span>
        </span>
        <div className="flex-1" />
        <span className="flex items-center gap-3 text-xs text-slate-400">
          <span title="Unread voicemail" className="flex items-center">
            Voicemail
            <Badge count={voicemailCount} />
          </span>
          <span title="Missed calls since you were last seen" className="flex items-center">
            Missed
            <Badge count={missedCallsCount} />
          </span>
          <span title="Unread WhatsApp/SMS" className="flex items-center">
            Chat
            <Badge count={whatsappUnreadCount} />
          </span>
        </span>
        {(role === "SUPERVISOR" || role === "ADMIN") && (
          <Link href="/admin" className="text-xs text-cyan hover:underline">
            Admin
          </Link>
        )}
        <span className="hidden text-xs text-slate-500 sm:inline">{userEmail}</span>
        <form action={signOutAction}>
          <button type="submit" className="rounded-lg border border-border px-3 py-1 text-xs text-slate-300 hover:border-cyan hover:text-cyan">
            Sign out
          </button>
        </form>
      </header>
      {children}
    </div>
  );
}
