import { cn } from "@/lib/utils";

/** Doherty: show one of these on any fetch that can exceed ~400ms. */
export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "animate-pulse rounded-[var(--radius)] bg-surface-subtle",
        className,
      )}
      {...props}
    />
  );
}
