"use client";

import { useState } from "react";

// POSTs to /api/messaging/conversations/[id]/messages — the route resolves
// the correct provider (OpenWA/Meta Cloud for WhatsApp, Dinstar for SMS)
// from the conversation itself via src/lib/messaging/registry.ts, so the
// composer doesn't need a channel selector: a conversation is already
// scoped to one channel (see Conversation.channel in prisma/schema.prisma
// — a contact with both an open WhatsApp and SMS thread appears as two
// separate conversations in the list, each with its own composer).
export function MessageComposer({ conversationId, channel }: { conversationId: string; channel: "WHATSAPP" | "SMS" }) {
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
      const data = await res.json();
      if (res.ok) {
        setText("");
      } else {
        setError(data.error ?? "Send failed");
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-1 border-t border-border pt-3">
      <div className="flex gap-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder={`Message via ${channel === "WHATSAPP" ? "WhatsApp" : "SMS"}...`}
          className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus:border-cyan"
        />
        <button
          onClick={send}
          disabled={sending}
          className="rounded-lg bg-cyan px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
        >
          Send
        </button>
      </div>
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
