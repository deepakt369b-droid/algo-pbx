import { AgentMissedCalls } from "@/components/agent-missed-calls";
import { AgentRecordings } from "@/components/agent-recordings";
import { AgentStatusSelector } from "@/components/agent-status-selector";
import { AgentVoicemail } from "@/components/agent-voicemail";
import { CallControls } from "@/components/call-controls";
import { Dialpad } from "@/components/dialpad";

// P3 (agent UI rehaul, LLM.md §28/29): this is the former /agent page,
// relocated here unchanged — the CRM is now the home page (/agent), and
// this is its "Call" sibling. Every component below is the exact same
// component with the exact same behavior; only the page it lives on
// changed. sip-context.tsx was NOT touched for this move.
export default function AgentCallPage() {
  return (
    <main className="p-8">
      <h1 className="mb-6 text-center text-xl font-semibold text-primary lg:text-left">Call</h1>
      <div className="mx-auto flex max-w-3xl flex-col items-center gap-6">
        <AgentStatusSelector />
        <div className="flex flex-col gap-6 md:flex-row">
          <Dialpad />
          <CallControls />
        </div>
        <AgentMissedCalls />
        <AgentVoicemail />
        <AgentRecordings />
      </div>
    </main>
  );
}
