"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { MessageComposer } from "./message-composer";

interface ChatMessageDto {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  body: string | null;
  mediaUrl: string | null;
  sensitive: boolean;
  accessRequestStatus: "none" | "pending" | "approved" | "declined" | "revoked" | "expired";
  deliveryStatus: string;
  createdAt: string;
}

// Delivery ticks for outbound messages — the DTO always carried
// deliveryStatus but it was never rendered. Anything not yet confirmed is a
// single tick; SENT/DELIVERED/READ double up.
function DeliveryTicks({ status, outbound }: { status: string; outbound: boolean }) {
  if (!outbound) return null;
  const upper = status.toUpperCase();
  const failed = upper === "FAILED";
  const pending = upper === "" || upper === "PENDING" || upper === "QUEUED" || upper === "SENDING";
  return (
    <span className={cn("ml-1 text-[10px]", failed ? "text-red-400" : "opacity-60")}>
      {failed ? "!" : pending ? "✓" : "✓✓"}
    </span>
  );
}

// Polls GET /api/messaging/conversations/[id]/messages every 5s. Renders
// WhatsApp and SMS interleaved (the route already returns whichever
// channel this conversation is) with a lock affordance for any message
// the server withheld — see src/lib/messaging/conversation-access.ts's
// redactMessagesForSession(): a withheld message always arrives here with
// body: null and sensitive: true, never with real content hidden by CSS.
export function ChatThread({ conversationId }: { conversationId: string }) {
  const [messages, setMessages] = useState<ChatMessageDto[]>([]);
  const [channel, setChannel] = useState<"WHATSAPP" | "SMS">("WHATSAPP");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Clear the previous conversation's messages immediately on switch —
  // they used to linger until the new fetch resolved, briefly showing one
  // conversation's messages under the other's composer.
  useEffect(() => {
    setMessages([]);
  }, [conversationId]);

  const load = async () => {
    try {
      const res = await fetch(`/api/messaging/conversations/${conversationId}/messages`, { cache: "no-store" });
      if (!res.ok) return; // transient poll error: keep last good data on screen
      const data = await res.json();
      setMessages(data.messages ?? []);
      if (data.channel) setChannel(data.channel);
    } catch {
      // keep last good data on transient network errors
    }
  };

  useEffect(() => {
    let cancelled = false;
    load();
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load is stable per conversationId
  }, [conversationId]);

  // Auto-scroll to the newest message once render settles — long threads
  // used to open at the top with no indication newer content existed.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const requestAccess = async (messageId: string) => {
    try {
      await fetch("/api/messaging/sms-access-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId }),
      });
      await load(); // reflect PENDING immediately instead of waiting for the next poll
    } catch {
      // surfaced by the next poll's state anyway
    }
  };

  return (
    <div className="glass-card flex h-full flex-1 flex-col p-3">
      <div ref={scrollRef} className="flex-1 space-y-2 overflow-y-auto">
        {messages.map((m) => (
          <div
            key={m.id}
            className={cn(
              "max-w-[70%] rounded-lg px-3 py-2 text-sm",
              m.direction === "OUTBOUND" ? "ml-auto bg-cyan text-background" : "bg-surface text-slate-200"
            )}
          >
            {m.sensitive && !m.body ? (
              <div className="flex flex-col gap-1">
                <p className="text-xs italic text-slate-400">🔒 Sensitive message withheld</p>
                {m.accessRequestStatus === "none" || m.accessRequestStatus === "expired" ? (
                  <button
                    onClick={() => requestAccess(m.id)}
                    className="w-fit rounded bg-blue px-2 py-1 text-xs font-medium text-white"
                  >
                    Request access
                  </button>
                ) : (
                  <p className="text-xs text-slate-500">Request: {m.accessRequestStatus}</p>
                )}
              </div>
            ) : (
              <>
                {m.body && <p>{m.body}</p>}
                {/* Media (images/audio) finally renders — mediaUrl was in
                    the DTO since day one but nothing ever displayed it, so
                    WhatsApp image/audio messages showed as empty bubbles. */}
                {m.mediaUrl && /\.(png|jpe?g|gif|webp)(\?|$)/i.test(m.mediaUrl) && (
                  // eslint-disable-next-line @next/next/no-img-element -- media URLs are same-origin API routes with auth cookies
                  <img src={m.mediaUrl} alt="shared media" className="mt-1 max-h-48 rounded" />
                )}
                {m.mediaUrl && !/\.(png|jpe?g|gif|webp)(\?|$)/i.test(m.mediaUrl) && (
                  <a href={m.mediaUrl} target="_blank" rel="noreferrer" className="mt-1 block text-xs underline">
                    Open attachment
                  </a>
                )}
              </>
            )}
            <p className="mt-1 text-[10px] opacity-60">
              {new Date(m.createdAt).toLocaleTimeString()}
              <DeliveryTicks status={m.deliveryStatus} outbound={m.direction === "OUTBOUND"} />
            </p>
          </div>
        ))}
        {messages.length === 0 && <p className="text-xs text-slate-500">No messages yet.</p>}
      </div>
      <MessageComposer conversationId={conversationId} channel={channel} onSent={load} />
    </div>
  );
}
