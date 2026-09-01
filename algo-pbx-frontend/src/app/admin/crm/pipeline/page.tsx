import { PipelineBoard } from "@/components/crm/pipeline-board";

export const metadata = { title: "Pipeline — Algo PBX" };

export default function AdminPipelinePage() {
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-[15px] font-semibold text-primary">Pipeline</h1>
      <PipelineBoard apiBase="/api/admin/crm" />
    </div>
  );
}
