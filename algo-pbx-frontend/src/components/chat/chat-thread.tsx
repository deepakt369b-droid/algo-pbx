"use client";

import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { MessageComposer } from "./message-composer";
import { ChatAvatar } from "./chat-avatar";
import { VoiceBubble } from "./voice-bubble";

interface ChatMessageDto {
  id: string;
  direction: "INBOUND" | "OUTBOUND";
  body: string | null;
  mediaUrl: string | null;
  mediaMimeType: string | null;
  mediaKind: string | null;
  sensitive: boolean;
  accessRequestStatus: "none" | "pending" | "approved" | "declined" | "revoked" | "expired";
  deliveryStatus: string;
  createdAt: string;
}

interface ThreadContact {
  id: string;
  numberE164: string;
  displayName: string | null;
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

/** Resolve a message's media category. `mediaKind` (set at ingest from the
 * OpenWA message type) is authoritative; mime / URL extension are fallbacks
 * for older rows. */
type MediaCat = "voice" | "image" | "video" | "audio" | "document" | "sticker" | null;
function mediaCat(m: Pick<ChatMessageDto, "mediaKind" | "mediaMimeType" | "mediaUrl">): MediaCat {
  if (m.mediaKind) return m.mediaKind as MediaCat;
  if (!m.mediaUrl) return null;
  const mime = (m.mediaMimeType ?? "").toLowerCase();
  if (mime.startsWith("audio/")) return "voice";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (/\.(ogg|oga|opus|mp3|m4a|wav|aac)(\?|$)/i.test(m.mediaUrl)) return "voice";
  if (/\.(png|jpe?g|gif|webp)(\?|$)/i.test(m.mediaUrl)) return "image";
  if (/\.(mp4|mov|webm|3gp)(\?|$)/i.test(m.mediaUrl)) return "video";
  return "document";
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
  const cat = mediaCat(message);
  const withheld = message.sensitive && !message.body && !message.mediaUrl;

  return (
    <div className={cn("flex", outbound ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "relative max-w-[85%] rounded-[var(--radius-lg)] px-3 py-2 text-sm shadow-sm sm:max-w-[72%]",
          cat === "sticker" && "!bg-transparent !shadow-none !px-0 !py-0",
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
            {/* Voice note — full WhatsApp-style player. */}
            {message.mediaUrl && cat === "voice" && (
              <VoiceBubble src={message.mediaUrl} outbound={outbound} />
            )}

            {/* Non-voice audio — plain controls. */}
            {message.mediaUrl && cat === "audio" && (
              <audio controls src={message.mediaUrl} className="mt-1 h-9 w-full max-w-[15rem]" />
            )}

            {message.mediaUrl && cat === "image" && (
              // eslint-disable-next-line @next/next/no-img-element -- same-origin auth-cookie proxy route
              <img
                src={message.mediaUrl}
                alt={message.body ?? "shared image"}
                className="mt-1 max-h-72 cursor-zoom-in rounded-[var(--radius)]"
                onClick={() => window.open(message.mediaUrl!, "_blank")}
              />
            )}

            {message.mediaUrl && cat === "video" && (
              <video
                controls
                src={message.mediaUrl}
                className="mt-1 max-h-72 rounded-[var(--radius)]"
              />
            )}

            {message.mediaUrl && cat === "sticker" && (
              // eslint-disable-next-line @next/next/no-img-element -- same-origin auth-cookie proxy route
              <img src={message.mediaUrl} alt="sticker" className="h-28 w-28 object-contain" />
            )}

            {message.mediaUrl && cat === "document" && (
              <a
                href={message.mediaUrl}
                target="_blank"
                rel="noreferrer"
                className={cn(
                  "mt-1 flex items-center gap-2 rounded-[var(--radius)] px-2.5 py-2 text-xs font-medium",
                  outbound ? "bg-canvas/15" : "bg-surface-subtle"
                )}
              >
                <span aria-hidden>📄</span>
                <span className="truncate">{message.body || "Document"}</span>
              </a>
            )}

            {message.body && cat !== "document" && (
              <p className={cn("whitespace-pre-wrap break-words", message.mediaUrl && "mt-1")}>
                {message.body}
              </p>
            )}
          </>
        )}
        {cat !== "sticker" && (
          <p
            className={cn(
              "mt-1 flex items-center justify-end text-[10px]",
              outbound ? "text-accent-fg/70" : "text-tertiary"
            )}
          >
            {new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            <DeliveryTicks status={message.deliveryStatus} outbound={outbound} />
          </p>
        )}
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
  const [contact, setContact] = useState<ThreadContact | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  // A 404 here means "not yours to see" (conversation-access.ts's
  // reassign-hides-it rule) as much as it means transient poll failure.
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  // True until the first successful load of a conversation — controls the
  // one-time scroll-to-bottom (later loads must not yank the view down).
  const freshRef = useRef(true);

  useEffect(() => {
    setMessages([]);
    setContact(null);
    setHasMore(false);
    setError(null);
    freshRef.current = true;
  }, [conversationId]);

  /** Merge a batch in by id, keep chronological, dedupe. */
  const mergeMessages = (incoming: ChatMessageDto[]) =>
    setMessages((prev) => {
      const byId = new Map(prev.map((m) => [m.id, m]));
      for (const m of incoming) byId.set(m.id, m);
      return [...byId.values()].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
    });

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
      mergeMessages(data.messages ?? []);
      if (freshRef.current) setHasMore(!!data.hasMore);
      if (data.channel) setChannel(data.channel);
      if (data.contact) setContact(data.contact);
    } catch {
      setError("Network error — retrying…");
    }
  };

  const loadOlder = async () => {
    const oldest = messages[0]?.createdAt;
    if (!oldest || loadingOlder || !hasMore) return;
    setLoadingOlder(true);
    const el = scrollRef.current;
    const prevHeight = el?.scrollHeight ?? 0;
    try {
      const res = await fetch(
        `/api/messaging/conversations/${conversationId}/messages?before=${encodeURIComponent(oldest)}`,
        { cache: "no-store" }
      );
      if (res.ok) {
        const data = await res.json();
        mergeMessages(data.messages ?? []);
        setHasMore(!!data.hasMore);
        // Keep the reader's viewport anchored where it was.
        requestAnimationFrame(() => {
          if (el) el.scrollTop = el.scrollHeight - prevHeight + el.scrollTop;
        });
      }
    } catch {
      /* next scroll retries */
    } finally {
      setLoadingOlder(false);
    }
  };

  useEffect(() => {
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- load is stable per conversationId
  }, [conversationId]);

  // Scroll to bottom once on open; afterwards only when the reader is
  // already near the bottom (so an incoming message doesn't interrupt
  // someone reading older history).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || messages.length === 0) return;
    if (freshRef.current) {
      el.scrollTop = el.scrollHeight;
      freshRef.current = false;
      return;
    }
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages]);

  // Load older when scrolled near the top.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop < 80 && hasMore && !loadingOlder) void loadOlder();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasMore, loadingOlder, messages]);

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
        {channel === "WHATSAPP" && contact && (
          <ChatAvatar
            name={contact.displayName ?? contact.numberE164}
            src={`/api/messaging/avatar/${contact.id}`}
            size={34}
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold text-primary">
            {contact?.displayName ?? contactLabel ?? contact?.numberE164 ?? "Conversation"}
          </p>
          {contact?.displayName && (
            <p className="truncate text-[11px] text-tertiary">{contact.numberE164}</p>
          )}
        </div>
        <span className="flex-shrink-0 rounded-full bg-surface-subtle px-2 py-0.5 text-[10px] font-medium text-secondary">
          {channel === "WHATSAPP" ? "WhatsApp" : "SMS"}
        </span>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 space-y-1.5 overflow-y-auto bg-canvas px-3 py-3">
        {error && <p className="text-xs text-danger">{error}</p>}
        {(hasMore || loadingOlder) && (
          <div className="flex justify-center py-1">
            <button
              type="button"
              onClick={loadOlder}
              disabled={loadingOlder}
              className="rounded-full bg-surface-subtle px-3 py-1 text-[11px] font-medium text-secondary hover:text-primary disabled:opacity-60"
            >
              {loadingOlder ? "Loading earlier messages…" : "Load earlier messages"}
            </button>
          </div>
        )}
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
