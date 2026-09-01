"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment } from "react";
import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  Transition,
  TransitionChild,
} from "@headlessui/react";
import {
  Users,
  Phone,
  History,
  Voicemail as VoicemailIcon,
  PhoneMissed,
  MessageCircle,
  ShieldCheck,
  Menu as MenuIcon,
} from "lucide-react";
import { useSIP } from "@/contexts/sip-context";
import { countUnseenVoicemail } from "@/lib/voicemail-unread";
import { useSessionIdentityGuard } from "@/lib/use-session-identity-guard";
import { IncomingCallBanner } from "@/components/incoming-call-banner";
import { SidebarNav, type NavGroup } from "@/components/shell/sidebar-nav";
import { ThemeToggleButton } from "@/components/shell/theme-toggle";

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

// Two-level sidebar shared with the admin shell (F4). Pipeline/Tasks
// sub-cards are added by S2b once /agent/crm/* exists.
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

  const navGroups: NavGroup[] = [
    {
      label: "Work",
      items: [
        { href: "/agent", label: "Contacts", icon: Users },
        { href: "/agent/call", label: "Call", icon: Phone },
        { href: "/agent/calls", label: "Calls", icon: History },
        { href: "/agent/missed", label: "Missed", icon: PhoneMissed, badge: missedCallsCount },
        { href: "/agent/voicemail", label: "Voicemail", icon: VoicemailIcon, badge: voicemailCount },
      ],
    },
    {
      label: "Messaging",
      items: [{ href: "/agent/chat", label: "Chat", icon: MessageCircle, badge: whatsappUnreadCount }],
    },
  ];

  const [mobileOpen, setMobileOpen] = useState(false);

  const rail = (onNavigate?: () => void) => (
    <div className="flex h-full flex-col">
      <div className="flex flex-col gap-2 border-b px-4 py-4 [border-color:rgb(var(--hairline))]">
        <span className="text-[15px] font-semibold tracking-tight text-primary">Algo PBX</span>
        <span
          className="flex w-fit items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs [border-color:rgb(var(--hairline))]"
          title={isConnected ? "Softphone registered" : "Softphone not connected — you cannot receive calls"}
        >
          <span className={`h-1.5 w-1.5 rounded-full ${isConnected ? "bg-success" : "bg-danger"}`} />
          <span className={isConnected ? "text-success" : "text-danger"}>{isConnected ? "Connected" : "Disconnected"}</span>
        </span>
      </div>

      <SidebarNav groups={navGroups} pathname={pathname} onNavigate={onNavigate} />

      <div className="flex flex-col gap-2 border-t px-4 py-3 [border-color:rgb(var(--hairline))]">
        {(role === "SUPERVISOR" || role === "ADMIN") && (
          <Link href="/admin" className="flex items-center gap-2 text-xs text-accent hover:underline">
            <ShieldCheck className="h-3.5 w-3.5" />
            Admin
          </Link>
        )}
        <span className="truncate text-xs text-tertiary" title={userEmail ?? undefined}>
          {userEmail}
        </span>
        <form action={signOutAction}>
          <button
            type="submit"
            className="w-full rounded-[var(--radius)] border px-3 py-1.5 text-xs text-secondary hover:bg-surface-hover hover:text-primary [border-color:rgb(var(--hairline))]"
          >
            Sign out
          </button>
        </form>
      </div>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-canvas text-primary">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r bg-surface md:block [border-color:rgb(var(--hairline))]">
        {rail()}
      </aside>

      <Transition show={mobileOpen} as={Fragment}>
        <Dialog onClose={setMobileOpen} className="relative z-50 md:hidden">
          <TransitionChild
            as={Fragment}
            enter="ease-out duration-150"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in duration-100"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <DialogBackdrop className="fixed inset-0 bg-black/50" />
          </TransitionChild>
          <TransitionChild
            as={Fragment}
            enter="ease-out duration-200"
            enterFrom="-translate-x-full"
            enterTo="translate-x-0"
            leave="ease-in duration-150"
            leaveFrom="translate-x-0"
            leaveTo="-translate-x-full"
          >
            <DialogPanel className="fixed inset-y-0 left-0 w-72 border-r bg-surface [border-color:rgb(var(--hairline))]">
              {rail(() => setMobileOpen(false))}
            </DialogPanel>
          </TransitionChild>
        </Dialog>
      </Transition>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-canvas/80 px-4 backdrop-blur [border-color:rgb(var(--hairline))]">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
            className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius)] text-secondary hover:bg-surface-hover hover:text-primary md:hidden"
          >
            <MenuIcon size={18} />
          </button>
          <div className="flex-1" />
          <ThemeToggleButton />
        </header>

        {/* Confirmed live 2026-08-29: an inbound call rang for its full 15s
            RINGNOANSWER window with no audible alert, because a blocked
            ringtone play() was previously swallowed silently. A blocked
            ringtone must never again be invisible — clicking this banner is
            itself the user gesture that unlocks it. */}
        {ringtoneBlocked && (
          <div className="sticky top-0 z-20 flex items-center justify-center gap-2 border-b border-warning/40 bg-warning-subtle px-4 py-2 text-xs text-warning">
            <span>🔔 Call sounds are blocked by your browser — you may miss incoming calls.</span>
            <button onClick={retryRingtone} className="underline hover:text-warning">
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
