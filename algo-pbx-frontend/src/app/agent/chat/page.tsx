import { ChatPanel } from "@/components/chat/chat-panel";

// Same pattern as agent/voicemail/page.tsx — see that file's comment.
// ChatPanel already owns its own polling (conversations list, thread,
// WhatsApp connection badge) and is a self-contained fixed-height widget,
// so it's rendered as-is rather than restyled for a full page.
//
// ?number=<E164> is the CRM's "WhatsApp" deep-link entry point (P3): a
// contact's WhatsApp button navigates here with their number, and
// ChatPanel resolves it to the existing conversation or creates a fresh
// one, per its own header comment.
export default function AgentChatPage({ searchParams }: { searchParams: { number?: string } }) {
  return (
    <div className="flex w-full flex-col items-center gap-6 p-8">
      <h1 className="text-xl font-semibold text-primary">Chat</h1>
      <div className="w-full max-w-4xl">
        <ChatPanel initialNumber={searchParams.number} />
      </div>
    </div>
  );
}
