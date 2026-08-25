import { AgentRecordings } from "@/components/agent-recordings";
import { AgentStatusSelector } from "@/components/agent-status-selector";
import { AgentVoicemail } from "@/components/agent-voicemail";
import { CallControls } from "@/components/call-controls";
import { Dialpad } from "@/components/dialpad";
import { ChatPanel } from "@/components/chat/chat-panel";

// Was a single centered column (flex-col items-center, max-w-2xl children)
// on a full-width page — a large amount of unused horizontal space and no
// existing layout constraint in the way of widening it. Now a two-column
// grid: the softphone (unchanged components, unchanged behavior) on the
// left, the WhatsApp+SMS chat panel (Workstream E) on the right. Below
// lg, the columns stack — the softphone still gets priority since making
// a call is the more time-critical action on a small screen.
export default function AgentWorkspace() {
  return (
    <main className="min-h-screen bg-background p-8">
      <h1 className="mb-6 text-center text-xl font-semibold text-slate-100 lg:text-left">Agent Workspace</h1>
      <div className="mx-auto flex max-w-7xl flex-col gap-8 lg:flex-row lg:items-start">
        <div className="flex flex-col items-center gap-6 lg:w-[26rem] lg:flex-shrink-0">
          <AgentStatusSelector />
          <div className="flex flex-col gap-6 md:flex-row">
            <Dialpad />
            <CallControls />
          </div>
          <AgentVoicemail />
          <AgentRecordings />
        </div>
        <div className="flex-1">
          <ChatPanel />
        </div>
      </div>
    </main>
  );
}
