import { forwardRef } from "react";
import { cn } from "@/lib/utils";

const base =
  "w-full rounded-[var(--radius)] border bg-surface px-3 text-sm text-primary placeholder:text-tertiary transition-colors focus-visible:outline-none focus-visible:border-accent focus-visible:ring-2 [--tw-ring-color:rgb(var(--ring))] disabled:opacity-40 [border-color:rgb(var(--hairline))]";

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input ref={ref} className={cn(base, "h-10", className)} {...props} />
  ),
);
Input.displayName = "Input";

export const Textarea = forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn(base, "min-h-[80px] py-2", className)} {...props} />
));
Textarea.displayName = "Textarea";

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("mb-1.5 block text-[13px] font-medium text-secondary", className)}
      {...props}
    />
  );
}
