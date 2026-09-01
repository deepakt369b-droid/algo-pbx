import { AgentMissedCalls } from "@/components/agent-missed-calls";

// Same pattern as agent/voicemail/page.tsx — see that file's comment.
// AgentMissedCalls owns its own polling (GET /api/me/missed-calls) and
// its own "mark seen" handshake with the navbar badge via
// useMissedCallsRefresh (agent-shell.tsx's MissedCallsRefreshContext,
// which still spans this route since it wraps `children` at the layout
// level, not just the old single-page dashboard).
export default function AgentMissedCallsPage() {
  return (
    <div className="flex w-full flex-col items-center gap-6 p-8">
      <h1 className="text-xl font-semibold text-primary">Missed calls</h1>
      <AgentMissedCalls />
    </div>
  );
}
