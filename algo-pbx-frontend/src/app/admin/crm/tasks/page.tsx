import { TaskBoard } from "@/components/crm/task-board";

export const metadata = { title: "CRM tasks — Algo PBX" };

export default function AdminTasksPage() {
  return (
    <div className="flex max-w-3xl flex-col gap-4">
      <h1 className="text-[15px] font-semibold text-primary">CRM tasks</h1>
      <TaskBoard apiBase="/api/admin/crm" contactPath="/admin/contacts" contactParam="focus" />
    </div>
  );
}
