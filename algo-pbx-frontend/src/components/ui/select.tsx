"use client";

import {
  Listbox,
  ListboxButton,
  ListboxOption,
  ListboxOptions,
} from "@headlessui/react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type SelectOption<T extends string> = { value: T; label: string };

export function Select<T extends string>({
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  value: T | null;
  onChange: (v: T) => void;
  options: SelectOption<T>[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const current = options.find((o) => o.value === value) ?? null;
  return (
    <Listbox value={value ?? undefined} onChange={onChange} disabled={disabled}>
      <div className={cn("relative", className)}>
        <ListboxButton
          aria-label={ariaLabel}
          className="flex h-10 w-full items-center justify-between gap-2 rounded-[var(--radius)] border bg-surface px-3 text-sm text-primary transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 [--tw-ring-color:rgb(var(--ring))] [--tw-ring-offset-color:rgb(var(--canvas))] disabled:opacity-40 [border-color:rgb(var(--hairline))]"
        >
          <span className={cn("truncate", !current && "text-tertiary")}>
            {current?.label ?? placeholder}
          </span>
          <ChevronsUpDown size={15} className="shrink-0 text-tertiary" />
        </ListboxButton>
        <ListboxOptions
          anchor="bottom start"
          className="z-50 mt-1 max-h-64 w-[var(--button-width)] overflow-auto rounded-[var(--radius)] border bg-surface p-1 shadow-xl focus-visible:outline-none [border-color:rgb(var(--hairline))]"
        >
          {options.map((o) => (
            <ListboxOption
              key={o.value}
              value={o.value}
              className="flex cursor-pointer items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2.5 py-2 text-sm text-primary data-[focus]:bg-surface-hover"
            >
              <span className="truncate">{o.label}</span>
              {o.value === value && <Check size={15} className="text-accent" />}
            </ListboxOption>
          ))}
        </ListboxOptions>
      </div>
    </Listbox>
  );
}
