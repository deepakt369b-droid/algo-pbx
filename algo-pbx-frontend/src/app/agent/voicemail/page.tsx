import { AgentVoicemail } from "@/components/agent-voicemail";

// Mirrors admin/cdr/page.tsx's pattern: a thin server-component shell
// around an existing client component. AgentVoicemail already owns its
// own live polling (GET /api/voicemail every 15s) — this route adds no
// new data fetching, it only gives the navbar's "Voicemail" item (see
// agent-shell.tsx) somewhere real to link to. Before this route existed
// that item was a plain <span>; the panel itself was only reachable by
// scrolling the single /agent dashboard.
export default function AgentVoicemailPage() {
  return (
    <div className="flex w-full flex-col items-center gap-6 p-8">
      <h1 className="text-xl font-semibold text-slate-100">Voicemail</h1>
      <AgentVoicemail />
    </div>
  );
}
