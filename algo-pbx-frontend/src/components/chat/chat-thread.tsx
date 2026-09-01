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
// single tick; SENT/DELIVERED/READ double up; FAILED shows "!".
function DeliveryTicks({ status, outbound }: { status: string; outbound: boolean }) {
  if (!outbound) return null;
  const upper = status.toUpperCase();
  const failed = upper === "FAILED";
  const pending = upper === "" || upper === "PENDING" || upper === "QUEUED" || upper === "SENDING";
  const read = upper === "READ";
  return (
    <span
      className={cn(
        "ml-1 leading-none",
        failed ? "text-danger" : read ? "text-accent" : "opacity-70"
      )}
      aria-label={failed ? "failed" : pending ? "sent" : read ? "read" : "delivered"}
    >
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

const DAY_MS = 24 * 60 * 60 * 1000;

/** WhatsApp-style day label: "Today" / "Yesterday" / "12 March 2026". */
function dayLabel(iso: string): string {
  const d = new Date(iso);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((startOf(new Date()) - startOf(d)) / DAY_MS);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function DateSeparator({ iso }: { iso: string }) {
  return (
    <div className="my-3 flex justify-center">
      <span className="rounded-[var(--radius-sm)] bg-surface-subtle px-3 py-1 text-[11px] font-medium text-tertiary shadow-sm">
        {dayLabel(iso)}
      </span>
    </div>
  );
}

/** One message bubble — WhatsApp-Web-style: sender-aligned, rounded, with a
 * tail on the sender's side, timestamp + delivery ticks in the corner. */
function MessageBubble({
  message,
  onRequestAccess,
}: {
  message: ChatMessageDto;
  onRequestAccess: (id: string) => void;
}) {
  const outbound = message.direction === "OUTBOUND";
  const audio = isAudioAttachment(message);
  const image = isImageAttachment(message);
  const withheld = message.sensitive && !message.body;

  return (
    <div className={cn("flex", outbound ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "relative max-w-[85%] rounded-[var(--radius-lg)] px-3 py-2 text-sm shadow-sm sm:max-w-[72%]",
          outbound
            ? "rounded-br-sm bg-accent text-accent-fg"
            : "rounded-bl-sm border bg-surface text-primary"
        )}
      >
        {withheld ? (
          <div className="flex flex-col gap-1">
            <p className={cn("text-xs italic", outbound ? "text-accent-fg/80" : "text-secondary")}>
              🔒 Sensitive message withheld
            </p>
            {message.accessRequestStatus === "none" || message.accessRequestStatus === "expired" ? (
              <button
                onClick={() => onRequestAccess(message.id)}
                className="w-fit rounded-[var(--radius-sm)] bg-canvas/20 px-2 py-1 text-xs font-medium ring-1 ring-inset ring-current"
              >
                Request access
              </button>
            ) : (
              <p className={cn("text-xs", outbound ? "text-accent-fg/80" : "text-tertiary")}>
                Request: {message.accessRequestStatus}
              </p>
            )}
          </div>
        ) : (
          <>
            {message.body && <p className="whitespace-pre-wrap break-words">{message.body}</p>}

            {/* Voice notes / audio attachments — same <audio controls> pattern
                already proven working in agent-voicemail.tsx. mediaUrl is
                rendered as-is: it is whatever the ingesting webhook stored,
                same trust level the image rendering below already relies on. */}
            {message.mediaUrl && audio && (
              <div
                className={cn(
                  "mt-1 flex items-center gap-2 rounded-[var(--radius)] px-2 py-1.5",
                  outbound ? "bg-canvas/15" : "bg-surface-subtle"
                )}
              >
                <span aria-hidden className="text-base leading-none">
                  🎤
                </span>
                <audio controls src={message.mediaUrl} className="h-8 w-full max-w-[15rem]" />
              </div>
            )}

            {message.mediaUrl && !audio && image && (
              // eslint-disable-next-line @next/next/no-img-element -- media URLs are same-origin API routes with auth cookies
              <img
                src={message.mediaUrl}
                alt="shared media"
                className="mt-1 max-h-64 rounded-[var(--radius)]"
              />
            )}

            {message.mediaUrl && !audio && !image && (
              <a
                href={message.mediaUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 block text-xs font-medium underline"
              >
                Open attachment
              </a>
            )}
          </>
        )}
        <p
          className={cn(
            "mt-1 flex items-center justify-end text-[10px]",
            outbound ? "text-accent-fg/70" : "text-tertiary"
          )}
        >
          {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          <DeliveryTicks status={message.deliveryStatus} outbound={outbound} />
        </p>
      </div>
    </div>
  );
}

// Polls GET /api/messaging/conversations/[id]/messages every 5s and renders
// a WhatsApp-Web-style thread: the full scrollable message history, sender-
// aligned bubbles, per-day date separators, timestamps, and the composer
// pinned at the bottom. Deliberately does NOT reproduce WhatsApp Web's own
// status/settings buttons — this is a support-agent thread view. The header
// is contact label + channel pill only (plus, on mobile, a back arrow when
// `onBack` is supplied by the single-pane container).
export function ChatThread({
  conversationId,
  contactLabel,
  onBack,
}: {
  conversationId: string;
  contactLabel?: string;
  onBack?: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessageDto[]>([]);
  const [channel, setChannel] = useState<"WHATSAPP" | "SMS">("WHATSAPP");
  // A 404 here means "not yours to see" (conversation-access.ts's
  // reassign-hides-it rule) as much as it means transient poll failure.
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setMessages([]);
    setError(null);
  }, [conversationId]);

  const load = async () => {
    try {
      const res = await fetch(`/api/messaging/conversations/${conversationId}/messages`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setError(data?.error ?? `Couldn't load this conversation (${res.status}).`);
        return;
      }
      const data = await res.json();
      setError(null);
      setMessages(data.messages ?? []);
      if (data.channel) setChannel(data.channel);
    } catch {
      setError("Network error — retrying…");
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load is stable per conversationId
  }, [conversationId]);

  // Auto-scroll to the newest message on open and whenever new messages arrive.
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
      await load();
    } catch {
      // surfaced by the next poll's state anyway
    }
  };

  // min-h-0 is load-bearing: without it a flex column child with
  // overflow-y-auto refuses to shrink below its content height, so the
  // thread never scrolls inside a bounded parent.
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-[var(--radius-lg)] border bg-surface">
      {/* Minimal header: back arrow (mobile only, when in single-pane) +
          contact label + channel pill. No status/settings buttons. */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b bg-surface px-3 py-2.5">
        {onBack && (
          <button
            type="button"
            onClick={onBack}
            aria-label="Back to conversations"
            className="-ml-1 inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius)] text-secondary hover:bg-surface-hover hover:text-primary md:hidden"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
              <path
                d="M15 18l-6-6 6-6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        )}
        <p className="min-w-0 flex-1 truncate text-sm font-semibold text-primary">
          {contactLabel ?? "Conversation"}
        </p>
        <span className="flex-shrink-0 rounded-full bg-surface-subtle px-2 py-0.5 text-[10px] font-medium text-secondary">
          {channel === "WHATSAPP" ? "WhatsApp" : "SMS"}
        </span>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-1.5 overflow-y-auto bg-canvas px-3 py-3">
        {error && <p className="text-xs text-danger">{error}</p>}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const showDay = !prev || dayKey(prev.createdAt) !== dayKey(m.createdAt);
          return (
            <div key={m.id}>
              {showDay && <DateSeparator iso={m.createdAt} />}
              <MessageBubble message={m} onRequestAccess={requestAccess} />
            </div>
          );
        })}
        {!error && messages.length === 0 && (
          <p className="text-xs text-tertiary">No messages yet.</p>
        )}
      </div>
      <MessageComposer conversationId={conversationId} channel={channel} onSent={load} />
    </div>
  );
}
