import { PipelineBoard } from "@/components/crm/pipeline-board";

export const metadata = { title: "Pipeline — Algo PBX" };

export default function AgentPipelinePage() {
  return (
    <main className="flex flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <h1 className="text-[15px] font-semibold text-primary">Pipeline</h1>
      <PipelineBoard apiBase="/api/agent/crm" />
    </main>
  );
}
