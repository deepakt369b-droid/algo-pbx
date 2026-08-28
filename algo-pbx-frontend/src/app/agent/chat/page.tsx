import { ChatPanel } from "@/components/chat/chat-panel";

// Same pattern as agent/voicemail/page.tsx — see that file's comment.
// ChatPanel already owns its own polling (conversations list, thread,
// WhatsApp connection badge) and is a self-contained fixed-height widget,
// so it's rendered as-is rather than restyled for a full page.
export default function AgentChatPage() {
  return (
    <div className="flex w-full flex-col items-center gap-6 p-8">
      <h1 className="text-xl font-semibold text-slate-100">Chat</h1>
      <div className="w-full max-w-4xl">
        <ChatPanel />
      </div>
    </div>
  );
}
