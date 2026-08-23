"use client";

import { useEffect, useState } from "react";
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

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(`/api/messaging/conversations${mineOnly ? "?mine=true" : ""}`, { cache: "no-store" })
        .then((r) => r.json())
        .then((data) => {
          if (!cancelled) setConversations(data.conversations ?? []);
        })
        .catch(() => undefined);
    };
    load();
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [mineOnly]);

  return (
    <div className="glass-card flex h-full w-72 flex-shrink-0 flex-col gap-2 p-3">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">Conversations</h2>
        <label className="flex items-center gap-1 text-xs text-slate-500">
          <input type="checkbox" checked={mineOnly} onChange={(e) => setMineOnly(e.target.checked)} />
          Mine
        </label>
      </div>
      <ul className="flex flex-1 flex-col gap-1 overflow-y-auto">
        {conversations.length === 0 && <li className="text-xs text-slate-500">No conversations yet.</li>}
        {conversations.map((c) => (
          <li key={c.id}>
            <button
              onClick={() => onSelect(c.id)}
              className={cn(
                "flex w-full flex-col gap-1 rounded-lg border border-transparent px-2 py-2 text-left text-sm",
                selectedId === c.id ? "border-cyan bg-surface" : "hover:bg-surface"
              )}
            >
              <div className="flex items-center justify-between">
                <span className="truncate text-slate-200">
                  {c.contact.displayName ?? c.contact.numberE164}
                </span>
                {c.unreadCount > 0 && (
                  <span className="rounded-full bg-cyan px-1.5 text-xs font-medium text-background">
                    {c.unreadCount}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", CHANNEL_BADGE[c.channel])}>
                  {c.channel}
                </span>
                {!c.assignedAgentId && <span className="text-[10px] text-slate-500">unassigned</span>}
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
