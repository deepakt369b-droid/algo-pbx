"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
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
  WHATSAPP: "bg-success-subtle text-success",
  SMS: "bg-accent-subtle text-accent",
};

/** Deterministic initials for the avatar disc. */
function initials(label: string): string {
  const clean = label.replace(/[^\p{L}\p{N} ]/gu, " ").trim();
  if (!clean) return "#";
  const parts = clean.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Short relative-ish timestamp for the conversation row, WhatsApp-style. */
function rowTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const yst = new Date(now);
  yst.setDate(now.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yst.getFullYear() &&
    d.getMonth() === yst.getMonth() &&
    d.getDate() === yst.getDate();
  if (isYesterday) return "Yesterday";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Polls GET /api/messaging/conversations every 5s — this codebase has no
// websocket/SSE infra, so a fast poll is the accepted "realtime" mechanism.
// An AGENT session sees their own assigned threads plus unassigned ones
// ("up for grabs" — first send claims it).
export function ConversationList({
  selectedId,
  onSelect,
}: {
  selectedId: string | null;
  onSelect: (id: string, label?: string) => void;
}) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [mineOnly, setMineOnly] = useState(false);
  const [stale, setStale] = useState(false);
  const [query, setQuery] = useState("");
  // New-conversation compose form. There is otherwise no way to start a
  // WhatsApp/SMS thread from the agent UI — every existing conversation
  // comes from an inbound message.
  const [composing, setComposing] = useState(false);
  const [composeNumber, setComposeNumber] = useState("");
  const [composeChannel, setComposeChannel] = useState<ConversationSummary["channel"]>("WHATSAPP");
  const [composeError, setComposeError] = useState<string | null>(null);
  const [composeBusy, setComposeBusy] = useState(false);
  // Optimistically-cleared unread counts, corrected by whichever poll lands next.
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

  const handleSelect = (id: string, label?: string) => {
    onSelect(id, label ?? conversations.find((c) => c.id === id)?.contact.displayName ?? undefined);
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
      handleSelect(data.conversationId);
      setComposing(false);
      setComposeNumber("");
    } catch {
      setComposeError("Network error — try again.");
    } finally {
      setComposeBusy(false);
    }
  };

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return conversations;
    return conversations.filter(
      (c) =>
        (c.contact.displayName ?? "").toLowerCase().includes(q) ||
        c.contact.numberE164.toLowerCase().includes(q)
    );
  }, [conversations, query]);

  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-[var(--radius-lg)] border bg-surface">
      <div className="flex flex-shrink-0 flex-col gap-2 border-b px-3 py-2.5">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-primary">Chats</h2>
          <div className="flex items-center gap-2">
            <label className="flex items-center gap-1 text-xs text-tertiary">
              <input
                type="checkbox"
                checked={mineOnly}
                onChange={(e) => setMineOnly(e.target.checked)}
                className="accent-accent"
              />
              Mine
            </label>
            <button
              type="button"
              onClick={() => {
                setComposing((v) => !v);
                setComposeError(null);
              }}
              className="rounded-[var(--radius-sm)] border px-2 py-1 text-xs font-medium text-accent hover:bg-surface-hover"
              title="Start a new conversation"
            >
              + New
            </button>
          </div>
        </div>
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search name or number"
          aria-label="Search conversations"
          className="w-full rounded-[var(--radius)] border bg-canvas px-3 py-1.5 text-sm text-primary outline-none placeholder:text-tertiary focus:border-accent"
        />
      </div>

      {composing && (
        <form
          onSubmit={handleCompose}
          className="flex flex-shrink-0 flex-col gap-2 border-b bg-surface-subtle p-3"
        >
          <input
            type="text"
            required
            placeholder="Phone number, e.g. +9715XXXXXXXX"
            value={composeNumber}
            onChange={(e) => setComposeNumber(e.target.value)}
            className="rounded-[var(--radius)] border bg-canvas px-3 py-2 text-sm text-primary outline-none focus:border-accent"
          />
          <select
            value={composeChannel}
            onChange={(e) => setComposeChannel(e.target.value as ConversationSummary["channel"])}
            className="rounded-[var(--radius)] border bg-canvas px-3 py-2 text-sm text-primary outline-none focus:border-accent"
          >
            <option value="WHATSAPP">WhatsApp</option>
            <option value="SMS">SMS</option>
          </select>
          {composeError && <p className="text-[11px] text-danger">{composeError}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setComposing(false)}
              className="rounded-[var(--radius-sm)] px-2 py-1 text-xs text-tertiary hover:bg-surface-hover"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={composeBusy}
              className="rounded-[var(--radius-sm)] bg-accent px-3 py-1 text-xs font-medium text-accent-fg disabled:opacity-50"
            >
              {composeBusy ? "Starting…" : "Start"}
            </button>
          </div>
        </form>
      )}

      {stale && (
        <p className="flex-shrink-0 bg-warning-subtle px-3 py-1 text-[11px] text-warning">
          Live updates unavailable — retrying…
        </p>
      )}

      <ul className="min-h-0 flex-1 overflow-y-auto">
        {visible.length === 0 && (
          <li className="px-3 py-4 text-xs text-tertiary">
            {conversations.length === 0 ? "No conversations yet." : "No matches."}
          </li>
        )}
        {visible.map((c) => {
          const unread = clearedIds.has(c.id) ? 0 : c.unreadCount;
          const label = c.contact.displayName ?? c.contact.numberE164;
          const active = selectedId === c.id;
          return (
            <li key={c.id}>
              {/* role="button" on a div, not a real <button> — a nested
                  <Link> (the CRM deep link) is invalid inside a <button>
                  and breaks hydration. The link's onClick stops propagation. */}
              <div
                role="button"
                tabIndex={0}
                onClick={() => handleSelect(c.id, label)}
                onKeyDown={(e) =>
                  (e.key === "Enter" || e.key === " ") &&
                  (e.preventDefault(), handleSelect(c.id, label))
                }
                className={cn(
                  "flex cursor-pointer items-center gap-3 border-b px-3 py-2.5 text-left",
                  active ? "bg-surface-hover" : "hover:bg-surface-hover"
                )}
              >
                <span
                  aria-hidden
                  className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-surface-subtle text-xs font-semibold text-secondary"
                >
                  {initials(label)}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">
                      {label}
                    </span>
                    {c.lastMessageAt && (
                      <span
                        className={cn(
                          "flex-shrink-0 text-[10px]",
                          unread > 0 ? "text-accent" : "text-tertiary"
                        )}
                      >
                        {rowTime(c.lastMessageAt)}
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 flex items-center gap-2">
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[10px] font-medium",
                        CHANNEL_BADGE[c.channel]
                      )}
                    >
                      {c.channel}
                    </span>
                    {!c.assignedAgentId && (
                      <span className="text-[10px] text-tertiary">unassigned</span>
                    )}
                    <Link
                      href={`/agent?contact=${c.contact.id}`}
                      onClick={(e) => e.stopPropagation()}
                      className="text-[10px] font-medium text-accent hover:underline"
                      title="Open this contact in the CRM"
                    >
                      CRM
                    </Link>
                    {unread > 0 && (
                      <span className="ml-auto flex h-5 min-w-[1.25rem] items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-semibold text-accent-fg">
                        {unread}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
