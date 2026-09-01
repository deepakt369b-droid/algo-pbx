"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Users, Phone, History, Voicemail as VoicemailIcon, PhoneMissed, MessageCircle, ShieldCheck } from "lucide-react";
import { useSIP } from "@/contexts/sip-context";
import { countUnseenVoicemail } from "@/lib/voicemail-unread";
import { useSessionIdentityGuard } from "@/lib/use-session-identity-guard";
import { IncomingCallBanner } from "@/components/incoming-call-banner";

const BASE_TITLE = "Algo PBX — Agent Workspace";

// Small, independent polls purely for the sidebar badge counts — each of
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
// read, re-poll the sidebar badge now" without prop-drilling through the
// page/layout boundary or waiting out the badge's own 20s interval.
const MissedCallsRefreshContext = createContext<() => void>(() => undefined);

export function useMissedCallsRefresh(): () => void {
  return useContext(MissedCallsRefreshContext);
}

function Badge({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <span className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-cyan px-1 text-[10px] font-semibold text-background">
      {count > 99 ? "99+" : count}
    </span>
  );
}

const SIDEBAR_WIDTH = "16rem";

// Left sidebar, card-style nav (LLM.md §31) — replaces the earlier
// single-line horizontal top-bar nav, which had grown to 6 destinations
// once /agent became the CRM and Call got its own page and no longer read
// as a real navigation surface. Matches the admin section's own sidebar
// shape (components/admin-shell/admin-shell.tsx, MUI Drawer) structurally
// — a fixed-width left rail, active-item highlight, badge counts — built
// in Tailwind here since the agent surface hasn't gone through the MUI
// migration yet (deliberately deferred, see LLM.md's plan).
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
  const { isConnected, callState, ringtoneBlocked, retryRingtone } = useSIP();
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

  const navItems = [
    // P3 (LLM.md §28/29): /agent is the CRM — the agent's main
    // interface — with Call as its own sibling page (the former /agent
    // softphone, unchanged). Both first so they read as the primary
    // destinations.
    { href: "/agent", label: "Contacts", icon: Users, count: 0, title: "CRM — your contacts" },
    { href: "/agent/call", label: "Call", icon: Phone, count: 0, title: "Dialpad and active call" },
    { href: "/agent/calls", label: "Calls", icon: History, count: 0, title: "Recent call history" },
    { href: "/agent/voicemail", label: "Voicemail", icon: VoicemailIcon, count: voicemailCount, title: "Unread voicemail" },
    { href: "/agent/missed", label: "Missed", icon: PhoneMissed, count: missedCallsCount, title: "Missed calls since you were last seen" },
    { href: "/agent/chat", label: "Chat", icon: MessageCircle, count: whatsappUnreadCount, title: "Unread WhatsApp/SMS" },
  ];

  return (
    <div className="flex min-h-screen bg-background">
      <aside
        className="sticky top-0 flex h-screen flex-shrink-0 flex-col border-r border-border bg-background/95 backdrop-blur"
        style={{ width: SIDEBAR_WIDTH }}
      >
        <div className="flex flex-col gap-2 border-b border-border px-4 py-4">
          <span className="text-sm font-semibold text-slate-100">Algo PBX</span>
          <span
            className="flex w-fit items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-xs"
            title={isConnected ? "Softphone registered" : "Softphone not connected — you cannot receive calls"}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${isConnected ? "bg-green-400" : "bg-red-400"}`} />
            <span className={isConnected ? "text-green-400" : "text-red-400"}>{isConnected ? "Connected" : "Disconnected"}</span>
          </span>
        </div>

        {/* Card-style nav — before this, all 6 destinations lived as plain
            text links in a single horizontal row in the header, which had
            stopped reading as real navigation once /agent became the CRM.
            isActive drives the same visible current-page indicator the old
            top bar had, now as a filled card instead of a text color. */}
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-3 py-3">
          {navItems.map(({ href, label, icon: Icon, count, title }) => {
            const isActive = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                title={title}
                aria-current={isActive ? "page" : undefined}
                className={`glass-card flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
                  isActive ? "border-cyan/60 bg-cyan/10 text-cyan" : "text-slate-300 hover:border-cyan/40 hover:text-cyan"
                }`}
              >
                <Icon className="h-4 w-4 flex-shrink-0" />
                <span className="flex-1">{label}</span>
                <Badge count={count} />
              </Link>
            );
          })}
        </nav>

        <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
          {(role === "SUPERVISOR" || role === "ADMIN") && (
            <Link href="/admin" className="flex items-center gap-2 text-xs text-cyan hover:underline">
              <ShieldCheck className="h-3.5 w-3.5" />
              Admin
            </Link>
          )}
          <span className="truncate text-xs text-slate-500" title={userEmail ?? undefined}>
            {userEmail}
          </span>
          <form action={signOutAction}>
            <button
              type="submit"
              className="w-full rounded-lg border border-border px-3 py-1.5 text-xs text-slate-300 hover:border-cyan hover:text-cyan"
            >
              Sign out
            </button>
          </form>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        {/* Confirmed live 2026-08-29: an inbound call rang for its full 15s
            RINGNOANSWER window with no audible alert, because a blocked
            ringtone play() was previously swallowed silently. A blocked
            ringtone must never again be invisible — clicking this banner is
            itself the user gesture that unlocks it. */}
        {ringtoneBlocked && (
          <div className="sticky top-0 z-20 flex items-center justify-center gap-2 border-b border-yellow-500/40 bg-yellow-500/10 px-4 py-2 text-xs text-yellow-400">
            <span>🔔 Call sounds are blocked by your browser — you may miss incoming calls.</span>
            <button onClick={retryRingtone} className="underline hover:text-yellow-300">
              Enable call sounds
            </button>
          </div>
        )}
        {/* Only hidden on /agent/call — CallControls there already renders
            its own ringing card, and showing both at once would be a
            confusing duplicate rather than a helpful redundancy. */}
        <IncomingCallBanner hidden={pathname === "/agent/call"} />
        <MissedCallsRefreshContext.Provider value={refreshMissedCalls}>{children}</MissedCallsRefreshContext.Provider>
      </div>
    </div>
  );
}
