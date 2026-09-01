"use client";

import { useState } from "react";
import {
  Combobox as HCombobox,
  ComboboxButton,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
} from "@headlessui/react";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type ComboOption<T extends string> = { value: T; label: string; hint?: string };

export function Combobox<T extends string>({
  value,
  onChange,
  options,
  placeholder = "Search…",
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  value: T | null;
  onChange: (v: T | null) => void;
  options: ComboOption<T>[];
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const [query, setQuery] = useState("");
  const filtered = query
    ? options.filter((o) => o.label.toLowerCase().includes(query.toLowerCase()))
    : options;
  const current = options.find((o) => o.value === value) ?? null;

  return (
    <HCombobox
      value={value}
      onChange={onChange}
      disabled={disabled}
      onClose={() => setQuery("")}
    >
      <div className={cn("relative", className)}>
        <div className="flex h-10 items-center rounded-[var(--radius)] border bg-surface pr-2 focus-within:ring-1 [border-color:rgb(var(--hairline))]">
          <ComboboxInput
            aria-label={ariaLabel}
            className="h-full w-full bg-transparent px-3 text-sm text-primary placeholder:text-tertiary focus-visible:outline-none"
            placeholder={placeholder}
            displayValue={() => current?.label ?? ""}
            onChange={(e) => setQuery(e.target.value)}
          />
          <ComboboxButton className="text-tertiary">
            <ChevronsUpDown size={15} />
          </ComboboxButton>
        </div>
        <ComboboxOptions
          anchor="bottom start"
          className="z-50 mt-1 max-h-64 w-[var(--input-width)] overflow-auto rounded-[var(--radius)] border bg-surface p-1 shadow-xl empty:hidden focus-visible:outline-none [border-color:rgb(var(--hairline))]"
        >
          {filtered.map((o) => (
            <ComboboxOption
              key={o.value}
              value={o.value}
              className="flex cursor-pointer items-center justify-between gap-2 rounded-[var(--radius-sm)] px-2.5 py-2 text-sm text-primary data-[focus]:bg-surface-hover"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{o.label}</span>
                {o.hint && <span className="truncate text-[11px] text-tertiary">{o.hint}</span>}
              </span>
              {o.value === value && <Check size={15} className="shrink-0 text-accent" />}
            </ComboboxOption>
          ))}
        </ComboboxOptions>
      </div>
    </HCombobox>
  );
}
