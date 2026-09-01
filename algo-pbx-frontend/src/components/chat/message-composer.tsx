"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

// POSTs to /api/messaging/conversations/[id]/messages — the route resolves
// the correct provider (OpenWA/Meta Cloud for WhatsApp, Dinstar for SMS)
// from the conversation itself via src/lib/messaging/registry.ts, so the
// composer doesn't need a channel selector: a conversation is already
// scoped to one channel.
//
// `onSent` lets the parent thread refetch immediately after a successful
// send — previously the just-sent message appeared only whenever the next
// 5s poll happened to land.
export function MessageComposer({
  conversationId,
  channel,
  onSent,
}: {
  conversationId: string;
  channel: "WHATSAPP" | "SMS";
  onSent?: () => void | Promise<void>;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    if (!text.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      const res = await fetch(`/api/messaging/conversations/${conversationId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      const data = await res.json().catch(() => null);
      if (res.ok) {
        setText("");
        await onSent?.();
      } else {
        setError(data?.error ?? "Send failed");
      }
    } catch {
      setError("Send failed — network error.");
    } finally {
      setSending(false);
    }
  };

  const label = `Message via ${channel === "WHATSAPP" ? "WhatsApp" : "SMS"}`;

  return (
    <div className="flex flex-shrink-0 flex-col gap-1 border-t bg-surface px-3 py-2.5">
      <div className="flex items-end gap-2">
        <textarea
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={`${label}…`}
          aria-label={label}
          className="max-h-32 min-h-[2.5rem] flex-1 resize-none rounded-[var(--radius-lg)] border bg-canvas px-3 py-2 text-sm text-primary outline-none placeholder:text-tertiary focus:border-accent"
        />
        <button
          onClick={send}
          disabled={sending || !text.trim()}
          aria-label="Send message"
          className={cn(
            "inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-accent text-accent-fg transition-opacity",
            (sending || !text.trim()) && "opacity-40"
          )}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path
              d="M3 11l18-8-8 18-2.5-7.5L3 11z"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinejoin="round"
              fill="currentColor"
            />
          </svg>
        </button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
