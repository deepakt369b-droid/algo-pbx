"use client";

import { useEffect, useState } from "react";
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

// Polls GET /api/messaging/conversations/[id]/messages every 5s. Renders
// WhatsApp and SMS interleaved (the route already returns whichever
// channel this conversation is) with a lock affordance for any message
// the server withheld — see src/lib/messaging/conversation-access.ts's
// redactMessagesForSession(): a withheld message always arrives here with
// body: null and sensitive: true, never with real content hidden by CSS.
export function ChatThread({ conversationId }: { conversationId: string }) {
  const [messages, setMessages] = useState<ChatMessageDto[]>([]);
  const [channel, setChannel] = useState<"WHATSAPP" | "SMS">("WHATSAPP");

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(`/api/messaging/conversations/${conversationId}/messages`, { cache: "no-store" })
        .then((r) => r.json())
        .then((data) => {
          if (!cancelled) {
            setMessages(data.messages ?? []);
            if (data.channel) setChannel(data.channel);
          }
        })
        .catch(() => undefined);
    };
    load();
    const interval = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [conversationId]);

  const requestAccess = async (messageId: string) => {
    await fetch("/api/messaging/sms-access-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messageId }),
    });
  };

  return (
    <div className="glass-card flex h-full flex-1 flex-col p-3">
      <div className="flex-1 space-y-2 overflow-y-auto">
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
              <p>{m.body}</p>
            )}
            <p className="mt-1 text-[10px] opacity-60">{new Date(m.createdAt).toLocaleTimeString()}</p>
          </div>
        ))}
        {messages.length === 0 && <p className="text-xs text-slate-500">No messages yet.</p>}
      </div>
      <MessageComposer conversationId={conversationId} channel={channel} />
    </div>
  );
}
