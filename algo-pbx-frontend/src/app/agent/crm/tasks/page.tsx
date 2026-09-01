import { TaskBoard } from "@/components/crm/task-board";

export const metadata = { title: "Tasks — Algo PBX" };

export default function AgentTasksPage() {
  return (
    <main className="flex max-w-3xl flex-col gap-4 p-4 sm:p-6 lg:p-8">
      <h1 className="text-[15px] font-semibold text-primary">Tasks</h1>
      <TaskBoard apiBase="/api/agent/crm" contactPath="/agent" contactParam="contact" />
    </main>
  );
}
