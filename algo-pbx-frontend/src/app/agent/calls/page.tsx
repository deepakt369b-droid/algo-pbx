import { AgentCallLog } from "@/components/agent-call-log";

// Same pattern as agent/voicemail/page.tsx and agent/missed/page.tsx —
// AgentCallLog owns its own polling (GET /api/me/calls). New this session:
// there was previously NO call-log view anywhere in the agent UI at all.
export default function AgentCallsPage() {
  return (
    <div className="flex w-full flex-col items-center gap-6 p-8">
      <h1 className="text-xl font-semibold text-primary">Call history</h1>
      <AgentCallLog />
    </div>
  );
}
