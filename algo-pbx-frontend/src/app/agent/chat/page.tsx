import { ChatPanel } from "@/components/chat/chat-panel";

// WhatsApp-Web-style chat workspace. ChatPanel owns its own polling
// (conversation list, thread, connection badge) and its own two-pane ⇄
// single-pane responsive geometry, so the page just gives it the viewport
// height left under the agent-shell header (h-14 = 3.5rem).
//
// ?number=<E164> is the CRM's "WhatsApp" deep-link entry point: a contact's
// WhatsApp button navigates here with their number and ChatPanel resolves
// it to the existing conversation or creates a fresh one.
export default function AgentChatPage({
  searchParams,
}: {
  searchParams: { number?: string };
}) {
  return (
    <div className="h-[calc(100dvh-3.5rem)] w-full p-2 sm:p-3">
      <ChatPanel initialNumber={searchParams.number} />
    </div>
  );
}
