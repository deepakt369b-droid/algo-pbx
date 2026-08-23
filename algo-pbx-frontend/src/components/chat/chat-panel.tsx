"use client";

import { useState } from "react";
import { ConversationList } from "./conversation-list";
import { ChatThread } from "./chat-thread";

// Top-level chat panel wired into agent/page.tsx's right-hand column.
// WhatsApp connection status/pairing/logout are entirely out of scope
// here and live exclusively in src/app/admin/whatsapp — this panel only
// ever reads and sends messages on conversations already assigned or
// claimable by the signed-in agent.
export function ChatPanel() {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  return (
    <div className="flex h-[36rem] w-full gap-3">
      <ConversationList selectedId={selectedId} onSelect={setSelectedId} />
      {selectedId ? (
        <ChatThread conversationId={selectedId} />
      ) : (
        <div className="glass-card flex flex-1 items-center justify-center text-sm text-slate-500">
          Select a conversation
        </div>
      )}
    </div>
  );
}
