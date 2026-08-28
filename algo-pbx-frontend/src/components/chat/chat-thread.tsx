"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { MessageComposer } from "./message-composer";

interface ChatMessageDto {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  body: string | null;
  mediaUrl: string | null;
  mediaMimeType: string | null;
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

/** True when this message's media is an audio attachment (WhatsApp voice
 * notes and the like) rather than an image/document. mediaMimeType is
 * preferred (present whenever the ingesting webhook reported one — see
 * openwa-provider.ts's parseInbound); the URL extension is only a
 * fallback for rows ingested before that field existed or from a channel
 * that never set it. */
function isAudioAttachment(m: Pick<ChatMessageDto, "mediaMimeType" | "mediaUrl">): boolean {
  if (m.mediaMimeType) return m.mediaMimeType.toLowerCase().startsWith("audio/");
  return !!m.mediaUrl && /\.(ogg|oga|opus|mp3|m4a|wav|aac)(\?|$)/i.test(m.mediaUrl);
}

function isImageAttachment(m: Pick<ChatMessageDto, "mediaMimeType" | "mediaUrl">): boolean {
  if (m.mediaMimeType) return m.mediaMimeType.toLowerCase().startsWith("image/");
  return !!m.mediaUrl && /\.(png|jpe?g|gif|webp)(\?|$)/i.test(m.mediaUrl);
}

/** One message bubble — WhatsApp-Web-style: sender-aligned, rounded,
 * timestamp + delivery ticks in the corner. */
function MessageBubble({ message, onRequestAccess }: { message: ChatMessageDto; onRequestAccess: (id: string) => void }) {
  const outbound = message.direction === "OUTBOUND";
  const audio = isAudioAttachment(message);
  const image = isImageAttachment(message);

  return (
    <div
      className={cn(
        "max-w-[72%] rounded-2xl px-3 py-2 text-sm shadow-sm",
        outbound
          ? "ml-auto rounded-br-sm bg-cyan text-background"
          : "mr-auto rounded-bl-sm bg-surface text-slate-200"
      )}
    >
      {message.sensitive && !message.body ? (
        <div className="flex flex-col gap-1">
          <p className="text-xs italic text-slate-400">🔒 Sensitive message withheld</p>
          {message.accessRequestStatus === "none" || message.accessRequestStatus === "expired" ? (
            <button
              onClick={() => onRequestAccess(message.id)}
              className="w-fit rounded bg-blue px-2 py-1 text-xs font-medium text-white"
            >
              Request access
            </button>
          ) : (
            <p className="text-xs text-slate-500">Request: {message.accessRequestStatus}</p>
          )}
        </div>
      ) : (
        <>
          {message.body && <p className="whitespace-pre-wrap break-words">{message.body}</p>}

          {/* Voice notes / audio attachments — same <audio controls> pattern
              already proven working in agent-voicemail.tsx. mediaUrl is
              rendered as-is: it is whatever the ingesting webhook stored,
              same trust level the existing image rendering below already
              relies on. */}
          {message.mediaUrl && audio && (
            <audio controls src={message.mediaUrl} className="mt-1 h-8 w-full max-w-[16rem]" />
          )}

          {message.mediaUrl && !audio && image && (
            // eslint-disable-next-line @next/next/no-img-element -- media URLs are same-origin API routes with auth cookies
            <img src={message.mediaUrl} alt="shared media" className="mt-1 max-h-48 rounded-lg" />
          )}

          {message.mediaUrl && !audio && !image && (
            <a href={message.mediaUrl} target="_blank" rel="noreferrer" className="mt-1 block text-xs underline">
              Open attachment
            </a>
          )}
        </>
      )}
      <p className={cn("mt-1 text-[10px]", outbound ? "text-background/70" : "opacity-60")}>
        {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        <DeliveryTicks status={message.deliveryStatus} outbound={outbound} />
      </p>
    </div>
  );
}

// Polls GET /api/messaging/conversations/[id]/messages every 5s and renders
// a WhatsApp-Web-style thread: the full scrollable message history (not
// just the latest message), sender-aligned bubbles, timestamps, and the
// composer pinned at the bottom. Deliberately does NOT reproduce WhatsApp
// Web's own status/settings buttons — this is a support-agent thread view,
// not a WhatsApp Web clone, and the operator was explicit they don't want
// those controls here. The header stays to "contact name/number + a
// connection indicator, nothing else" — `contactLabel`/`channel` let a
// caller that already has the contact (e.g. admin/sms's inbox list) show
// it; callers that don't pass one still get a minimal, working header
// rather than none at all.
export function ChatThread({
  conversationId,
  contactLabel,
}: {
  conversationId: string;
  contactLabel?: string;
}) {
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

  // Auto-scroll to the newest message on open and whenever new messages
  // arrive — long threads used to open at the top with no indication newer
  // content existed.
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
    // min-h-0 is load-bearing here: without it, a flex column child with
    // overflow-y-auto refuses to shrink below its content's height, so the
    // thread never actually scrolls inside a bounded parent (chat-panel.tsx's
    // fixed-height column, the admin slide-over panels) — it just grows,
    // which is what made this look like only the latest message(s) were
    // ever reachable.
    <div className="glass-card flex h-full min-h-0 flex-1 flex-col p-3">
      {/* Minimal header: contact + channel + a connection dot only. No
          status button, no settings button — explicitly not wanted here. */}
      <div className="mb-2 flex flex-shrink-0 items-center justify-between border-b border-border pb-2">
        <p className="truncate text-sm font-medium text-slate-100">{contactLabel ?? "Conversation"}</p>
        <span className="flex-shrink-0 rounded-full bg-background/60 px-2 py-0.5 text-[10px] font-medium text-slate-400">
          {channel === "WHATSAPP" ? "WhatsApp" : "SMS"}
        </span>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto">
        {messages.map((m) => (
          <MessageBubble key={m.id} message={m} onRequestAccess={requestAccess} />
        ))}
        {messages.length === 0 && <p className="text-xs text-slate-500">No messages yet.</p>}
      </div>
      <MessageComposer conversationId={conversationId} channel={channel} onSent={load} />
    </div>
  );
}
