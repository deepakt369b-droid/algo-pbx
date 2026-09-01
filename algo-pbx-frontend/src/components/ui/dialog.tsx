"use client";

import { Fragment, type ReactNode } from "react";
import {
  Dialog as HDialog,
  DialogBackdrop,
  DialogPanel,
  DialogTitle,
  Transition,
  TransitionChild,
} from "@headlessui/react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

// Accessibility (focus trap, aria, escape, scroll-lock) comes from Headless
// UI — not hand-rolled. This is only skin + transitions.
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  className,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
  size?: "sm" | "md" | "lg";
}) {
  const width = { sm: "max-w-sm", md: "max-w-lg", lg: "max-w-2xl" }[size];
  return (
    <Transition show={open} as={Fragment}>
      <HDialog onClose={onClose} className="relative z-50">
        <TransitionChild
          as={Fragment}
          enter="ease-out duration-150"
          enterFrom="opacity-0"
          enterTo="opacity-100"
          leave="ease-in duration-100"
          leaveFrom="opacity-100"
          leaveTo="opacity-0"
        >
          <DialogBackdrop className="fixed inset-0 bg-black/50 backdrop-blur-[2px]" />
        </TransitionChild>

        <div className="fixed inset-0 flex items-end justify-center p-0 sm:items-center sm:p-4">
          <TransitionChild
            as={Fragment}
            enter="ease-out duration-150"
            enterFrom="opacity-0 translate-y-3 sm:scale-95"
            enterTo="opacity-100 translate-y-0 sm:scale-100"
            leave="ease-in duration-100"
            leaveFrom="opacity-100 translate-y-0 sm:scale-100"
            leaveTo="opacity-0 translate-y-3 sm:scale-95"
          >
            <DialogPanel
              className={cn(
                "w-full overflow-hidden rounded-t-[var(--radius-lg)] border bg-surface shadow-xl sm:rounded-[var(--radius-lg)] [border-color:rgb(var(--hairline))]",
                width,
                className,
              )}
            >
              {(title || description) && (
                <div className="flex items-start justify-between gap-4 border-b px-5 py-4 [border-color:rgb(var(--hairline))]">
                  <div className="flex flex-col gap-1">
                    {title && (
                      <DialogTitle className="text-[15px] font-semibold text-primary">
                        {title}
                      </DialogTitle>
                    )}
                    {description && (
                      <p className="text-[13px] text-secondary">{description}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={onClose}
                    aria-label="Close"
                    className="-mr-1 -mt-1 inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius)] text-tertiary hover:bg-surface-hover hover:text-primary"
                  >
                    <X size={16} />
                  </button>
                </div>
              )}
              <div className="px-5 py-4">{children}</div>
            </DialogPanel>
          </TransitionChild>
        </div>
      </HDialog>
    </Transition>
  );
}
