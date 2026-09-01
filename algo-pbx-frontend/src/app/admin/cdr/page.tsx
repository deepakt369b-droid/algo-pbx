import { CdrTable } from "@/components/cdr-table";

export default function CdrPage() {
  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-primary">Call Detail Records</h1>
      <CdrTable />
    </div>
  );
}
