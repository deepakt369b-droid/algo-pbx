"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { cn } from "@/lib/utils";

interface ConversationSummary {
  id: string;
  channel: "WHATSAPP" | "SMS";
  contact: { id: string; numberE164: string; displayName: string | null };
  assignedAgentId: string | null;
  unreadCount: number;
  lastMessageAt: string | null;
  mine: boolean;
}

const CHANNEL_BADGE: Record<ConversationSummary["channel"], string> = {
  WHATSAPP: "bg-green-900/40 text-green-400",
  SMS: "bg-blue-900/40 text-blue-300",
};

// Polls GET /api/messaging/conversations every 5s — same pattern as
// src/components/wallboard.tsx (this codebase has no websocket/SSE infra;
// see sip-context.tsx's own comment on why a fast poll is the accepted
// "realtime" mechanism here). An AGENT session sees their own assigned
// threads plus unassigned ones ("up for grabs" — first send claims it, see
// src/lib/messaging/conversation-access.ts).
export function ConversationList({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [mineOnly, setMineOnly] = useState(false);
  const [stale, setStale] = useState(false);
  // New-conversation compose form. There is otherwise no way to start a
  // WhatsApp/SMS thread from the agent UI — every existing conversation
  // comes from an inbound message (see POST /api/messaging/conversations's
  // file header for the full gap description).
  const [composing, setComposing] = useState(false);
  const [composeNumber, setComposeNumber] = useState("");
  const [composeChannel, setComposeChannel] = useState<ConversationSummary["channel"]>("WHATSAPP");
  const [composeError, setComposeError] = useState<string | null>(null);
  const [composeBusy, setComposeBusy] = useState(false);
  // Locally-cleared unread counts: selecting a conversation used to leave
  // its badge up until the next poll reflected the server-side read mark.
  // The optimistic clear is corrected by whichever poll lands next.
  const [clearedIds, setClearedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    let failedOnce = false;
    const load = () => {
      fetch(`/api/messaging/conversations${mineOnly ? "?mine=true" : ""}`, { cache: "no-store" })
        .then((r) => {
          if (!r.ok) throw new Error(String(r.status));
          return r.json();
        })
        .then((data) => {
          if (!cancelled) {
            setConversations(data.conversations ?? []);
            setStale(false);
            failedOnce = false;
          }
        })
        .catch(() => {
          if (!cancelled && !failedOnce) {
            // Surface a stale indicator once; don't spam re-renders on
            // every failed poll while the backend is briefly unreachable.
            failedOnce = true;
            setStale(true);
          }
        });
    };
    load();
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [mineOnly]);

  const handleSelect = (id: string) => {
    onSelect(id);
    if ((conversations.find((c) => c.id === id)?.unreadCount ?? 0) > 0) {
      setClearedIds((prev) => new Set(prev).add(id));
    }
  };

  const handleCompose = async (e: FormEvent) => {
    e.preventDefault();
    setComposeError(null);
    setComposeBusy(true);
    try {
      const res = await fetch("/api/messaging/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ numberE164: composeNumber, channel: composeChannel }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) {
        setComposeError(data?.error ?? `Failed (${res.status})`);
        return;
      }
      // Select immediately rather than waiting up to 5s for the next poll
      // to surface the new row — the next poll will fill in its summary.
      handleSelect(data.conversationId);
      setComposing(false);
      setComposeNumber("");
    } catch {
      setComposeError("Network error — try again.");
    } finally {
      setComposeBusy(false);
    }
  };

  return (
    <div className="glass-card flex h-full w-72 flex-shrink-0 flex-col gap-2 p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Conversations</h2>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1 text-xs text-slate-500">
            <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
            Mine
          </label>
          <button
            type="button"
            onClick={() => {
              setComposing((v) => !v);
              setComposeError(null);
            }}
            className="rounded border border-border px-1.5 py-0.5 text-xs text-cyan hover:bg-surface"
            title="Start a new conversation"
          >
            + New
          </button>
        </div>
      </div>
      {composing && (
        <form onSubmit={handleCompose} className="flex flex-col gap-2 rounded-lg border border-border bg-background p-2">
          <input
            type="text"
            required
            placeholder="Phone number, e.g. +9715XXXXXXXX"
            value={composeNumber}
            onChange={(e) => setComposeNumber(e.target.value)}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-slate-200"
          />
          <select
            value={composeChannel}
            onChange={(e) => setComposeChannel(e.target.value as ConversationSummary["channel"])}
            className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-slate-200"
          >
            <option value="WHATSAPP">WhatsApp</option>
            <option value="SMS">SMS</option>
          </select>
          {composeError && <p className="text-[10px] text-red-400">{composeError}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setComposing(false)}
              className="rounded px-2 py-1 text-xs text-slate-500 hover:bg-surface"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={composeBusy}
              className="rounded bg-cyan px-2 py-1 text-xs font-medium text-background disabled:opacity-50"
            >
              {composeBusy ? "Starting…" : "Start"}
            </button>
          </div>
        </form>
      )}
      {stale && <p className="text-[10px] text-yellow-500">Live updates unavailable — retrying…</p>}
      <ul className="flex flex-1 flex-col gap-1 overflow-y-auto">
        {conversations.length === 0 && <li className="text-xs text-slate-500">No conversations yet.</li>}
        {conversations.map((c) => {
          const unread = clearedIds.has(c.id) ? 0 : c.unreadCount;
          return (
            <li key={c.id}>
              {/* `role="button"` on a div, not a real <button> — a nested
                  <a>/Link (the "View in CRM" deep link below, LLM.md §31)
                  is invalid inside a <button> and breaks hydration. The
                  link's own onClick stops propagation so clicking it opens
                  the contact instead of also selecting this conversation. */}
              <div
                role="button"
                tabIndex={0}
                onClick={() => handleSelect(c.id)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && handleSelect(c.id)}
                className={cn(
                  "flex w-full cursor-pointer flex-col gap-1 rounded-lg border border-transparent px-2 py-2 text-left text-sm",
                  selectedId === c.id ? "border-cyan bg-surface" : "hover:bg-surface"
                )}
              >
                <div className="flex items-center justify-between">
                  <span className="truncate text-slate-200">
                    {c.contact.displayName ?? c.contact.numberE164}
                  </span>
                  {unread > 0 && (
                    <span className="rounded-full bg-cyan px-1.5 text-xs font-medium text-background">
                      {unread}
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", CHANNEL_BADGE[c.channel])}>
                    {c.channel}
                  </span>
                  {!c.assignedAgentId && <span className="text-[10px] text-slate-500">unassigned</span>}
                  <Link
                    href={`/agent?contact=${c.contact.id}`}
                    onClick={(e) => e.stopPropagation()}
                    className="text-[10px] text-cyan hover:underline"
                    title="Open this contact in the CRM"
                  >
                    CRM
                  </Link>
                  {c.lastMessageAt && (
                    <span className="ml-auto text-[10px] text-slate-600">
                      {new Date(c.lastMessageAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                    </span>
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
