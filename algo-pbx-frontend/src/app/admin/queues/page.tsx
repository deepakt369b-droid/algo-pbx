import { QueueManager } from "@/components/queue-manager";

export default function QueuesPage() {
  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-slate-100">Queue & Ring Group Manager</h1>
      <QueueManager />
    </div>
  );
}
