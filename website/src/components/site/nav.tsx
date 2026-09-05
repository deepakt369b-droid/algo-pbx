"use client";

import { Dialog, DialogPanel } from "@headlessui/react";
import { Menu, X } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { ThemeToggleButton } from "@/components/theme-toggle";

const links = [
  { href: "/#features", label: "Features" },
  { href: "/#pricing", label: "Pricing" },
  { href: "/docs/", label: "Docs" },
  { href: "/#contact", label: "Contact" },
];

export function Nav() {
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 border-b bg-canvas/80 backdrop-blur" style={{ borderColor: "rgb(var(--hairline))" }}>
      <nav className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <Link href="/" className="text-base font-semibold tracking-tight text-primary">
          Algo PBX
        </Link>

        <div className="hidden items-center gap-8 sm:flex">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className="text-sm text-secondary hover:text-primary">
              {l.label}
            </Link>
          ))}
          <ThemeToggleButton />
        </div>

        <div className="flex items-center gap-2 sm:hidden">
          <ThemeToggleButton />
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => setOpen(true)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius)] border text-secondary"
            style={{ borderColor: "rgb(var(--hairline))" }}
          >
            <Menu size={18} />
          </button>
        </div>
      </nav>

      <Dialog open={open} onClose={setOpen} className="relative z-50">
        <div className="fixed inset-0 bg-black/30" aria-hidden="true" />
        <div className="fixed inset-0 flex justify-end">
          <DialogPanel className="w-full max-w-xs bg-canvas p-6">
            <div className="flex items-center justify-between">
              <span className="text-base font-semibold text-primary">Menu</span>
              <button
                type="button"
                aria-label="Close menu"
                onClick={() => setOpen(false)}
                className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius)] border text-secondary"
                style={{ borderColor: "rgb(var(--hairline))" }}
              >
                <X size={18} />
              </button>
            </div>
            <div className="mt-8 flex flex-col gap-6">
              {links.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="text-lg text-primary"
                >
                  {l.label}
                </Link>
              ))}
            </div>
          </DialogPanel>
        </div>
      </Dialog>
    </header>
  );
}
