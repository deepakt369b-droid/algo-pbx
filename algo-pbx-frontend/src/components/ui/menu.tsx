"use client";

import type { ReactNode } from "react";
import {
  Menu as HMenu,
  MenuButton,
  MenuItem,
  MenuItems,
} from "@headlessui/react";
import { cn } from "@/lib/utils";

export type MenuAction = {
  label: string;
  onClick: () => void;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
};

export function Menu({
  trigger,
  actions,
  align = "end",
  className,
}: {
  trigger: ReactNode;
  actions: MenuAction[];
  align?: "start" | "end";
  className?: string;
}) {
  return (
    <HMenu>
      <MenuButton as="div" className={cn("inline-flex", className)}>
        {trigger}
      </MenuButton>
      <MenuItems
        anchor={`bottom ${align}`}
        className="z-50 mt-1 min-w-44 rounded-[var(--radius)] border bg-surface p-1 shadow-xl focus-visible:outline-none [border-color:rgb(var(--hairline))]"
      >
        {actions.map((a, i) => (
          <MenuItem key={i} disabled={a.disabled}>
            <button
              type="button"
              onClick={a.onClick}
              className={cn(
                "flex w-full items-center gap-2 rounded-[var(--radius-sm)] px-2.5 py-2 text-left text-sm data-[focus]:bg-surface-hover data-[disabled]:opacity-40",
                a.danger ? "text-danger" : "text-primary",
              )}
            >
              {a.icon}
              {a.label}
            </button>
          </MenuItem>
        ))}
      </MenuItems>
    </HMenu>
  );
}
