"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSIP } from "@/contexts/sip-context";
import { countUnseenVoicemail } from "@/lib/voicemail-unread";
import { useSessionIdentityGuard } from "@/lib/use-session-identity-guard";

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
// Returns [count, refreshNow] — refreshNow lets a caller elsewhere in the
// tree (e.g. AgentMissedCalls, after its own mark-read POST resolves)
// force an immediate re-fetch instead of waiting up to `intervalMs` for
// the next poll. Before this, the badge and the panel that clears it had
// no way to talk to each other at all.
function useBadgeCount(url: string, extract: (data: unknown) => number, intervalMs = 20000): [number, () => void] {
  const [count, setCount] = useState(0);
  const loadRef = useRef<() => void>(() => undefined);

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
    loadRef.current = load;
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

  const refreshNow = useCallback(() => loadRef.current(), []);
  return [count, refreshNow];
}

// Lets AgentMissedCalls (rendered as a descendant of `children` below, not
// a direct child of this component) signal "I just marked missed calls as
// read, re-poll the navbar badge now" without prop-drilling through the
// page/layout boundary or waiting out the badge's own 20s interval.
const MissedCallsRefreshContext = createContext<() => void>(() => undefined);

export function useMissedCallsRefresh(): () => void {
  return useContext(MissedCallsRefreshContext);
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
  userId,
  userEmail,
  role,
  signOutAction,
}: {
  children: React.ReactNode;
  userId?: string | null;
  userEmail?: string | null;
  role?: "AGENT" | "SUPERVISOR" | "ADMIN";
  signOutAction: () => Promise<void>;
}) {
  const { isConnected, callState } = useSIP();
  const pathname = usePathname();
  // The "Admin" link below is drawn from `role`, which the server layout read
  // from a browser-wide cookie that a second sign-in can replace at any time.
  // This forces a re-render for whoever the cookie now belongs to.
  useSessionIdentityGuard(userId);

  const [voicemailCount] = useBadgeCount("/api/voicemail", (d) => {
    const { messages, lastSeenAt } = d as {
      messages?: { origtime: number | null }[];
      lastSeenAt?: string | null;
    };
    if (!messages) return 0;
    return countUnseenVoicemail(messages, lastSeenAt ?? null);
  });
  const [missedCallsCount, refreshMissedCalls] = useBadgeCount("/api/me/missed-calls", (d) => {
    const { calls, lastSeenAt } = d as { calls?: { startedAt: string }[]; lastSeenAt?: string | null };
    if (!calls) return 0;
    return lastSeenAt ? calls.filter((c) => new Date(c.startedAt) > new Date(lastSeenAt)).length : calls.length;
  });
  const [whatsappUnreadCount] = useBadgeCount("/api/messaging/conversations", (d) => {
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
        {/* Real links to /agent/{voicemail,missed,chat} — before this
            these were plain <span>s with a badge and nothing else;
            clicking did nothing, and the panels they named were only
            reachable by scrolling the single /agent dashboard. The badge
            counts themselves were already live (see useBadgeCount above),
            it was purely navigation that was missing. isActive drives a
            visible current-page indicator, since this bar has no sidebar
            to otherwise show where you are. */}
        <span className="flex items-center gap-3 text-xs text-slate-400">
          {[
            { href: "/agent/calls", label: "Calls", count: 0, title: "Recent call history" },
            { href: "/agent/voicemail", label: "Voicemail", count: voicemailCount, title: "Unread voicemail" },
            {
              href: "/agent/missed",
              label: "Missed",
              count: missedCallsCount,
              title: "Missed calls since you were last seen",
            },
            { href: "/agent/chat", label: "Chat", count: whatsappUnreadCount, title: "Unread WhatsApp/SMS" },
          ].map(({ href, label, count, title }) => {
            const isActive = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                title={title}
                aria-current={isActive ? "page" : undefined}
                className={`flex items-center hover:text-cyan ${isActive ? "text-cyan" : ""}`}
              >
                {label}
                <Badge count={count} />
              </Link>
            );
          })}
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
      <MissedCallsRefreshContext.Provider value={refreshMissedCalls}>{children}</MissedCallsRefreshContext.Provider>
    </div>
  );
}
