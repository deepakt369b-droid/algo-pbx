"use client";

import { Field, Label, Switch as HSwitch } from "@headlessui/react";
import { cn } from "@/lib/utils";

export function Switch({
  checked,
  onChange,
  label,
  disabled,
  className,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label?: string;
  disabled?: boolean;
  className?: string;
}) {
  const toggle = (
    <HSwitch
      checked={checked}
      onChange={onChange}
      disabled={disabled}
      className={cn(
        "group relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors focus-visible:outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40",
        checked ? "bg-accent" : "bg-surface-hover",
        className,
      )}
    >
      <span
        className={cn(
          "inline-block h-5 w-5 translate-x-0.5 rounded-full bg-white shadow transition-transform",
          checked && "translate-x-[18px]",
        )}
      />
    </HSwitch>
  );

  if (!label) return toggle;
  return (
    <Field className="flex items-center gap-3">
      {toggle}
      <Label className="text-sm text-primary data-[disabled]:opacity-40">{label}</Label>
    </Field>
  );
}
