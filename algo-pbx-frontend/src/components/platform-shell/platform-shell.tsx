"use client";

import { Fragment, useState } from "react";
import { usePathname } from "next/navigation";
import {
  Dialog,
  DialogBackdrop,
  DialogPanel,
  Transition,
  TransitionChild,
} from "@headlessui/react";
import {
  LayoutDashboard,
  Building2,
  ServerCog,
  Users2,
  FileCheck2,
  Settings,
  Menu as MenuIcon,
  LogOut,
} from "lucide-react";
import { SidebarNav, type NavGroup } from "@/components/shell/sidebar-nav";
import { ThemeToggleButton } from "@/components/shell/theme-toggle";
import { PlatformHealthPill } from "./platform-health-pill";

// The owner console's shell. Structurally mirrors AdminShell (same rail,
// drawer, topbar and token usage) so the two planes feel like one product —
// but it is a separate component with its own nav and its own health pill,
// because the planes are separate by design and a shared shell would invite
// exactly the cross-plane leakage the D2 split exists to prevent.
//
// The role badge in the topbar is not decoration: PLATFORM_SUPPORT and
// PLATFORM_OWNER see materially different consoles (owner-only actions are
// absent, not merely disabled), so an operator needs to know which one they
// are looking at before they wonder why a button is missing.

const NAV: NavGroup[] = [
  { label: "Overview", items: [{ href: "/platform", label: "Overview", icon: LayoutDashboard }] },
  {
    label: "Customers",
    items: [
      { href: "/platform/tenants", label: "Tenants", icon: Building2 },
      { href: "/platform/provisioning", label: "Provisioning", icon: ServerCog },
    ],
  },
  {
    label: "Access",
    items: [
      { href: "/platform/users", label: "Platform users", icon: Users2 },
      { href: "/platform/audit", label: "Audit center", icon: FileCheck2 },
    ],
  },
  {
    label: "Configuration",
    items: [{ href: "/platform/settings", label: "Platform settings", icon: Settings }],
  },
];

function Rail({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2 border-b px-4 [border-color:rgb(var(--hairline))]">
        <span className="text-[15px] font-semibold tracking-tight text-primary">Algo PBX</span>
        <span className="rounded-full bg-accent-subtle px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
          Platform
        </span>
      </div>
      <SidebarNav groups={NAV} pathname={pathname} onNavigate={onNavigate} />
    </div>
  );
}

export function PlatformShell({
  children,
  userEmail,
  role,
  signOutAction,
}: {
  children: React.ReactNode;
  userEmail: string;
  role: "PLATFORM_OWNER" | "PLATFORM_SUPPORT";
  signOutAction: () => Promise<void>;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-canvas text-primary">
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r bg-surface md:block [border-color:rgb(var(--hairline))]">
        <Rail pathname={pathname} />
      </aside>

      <Transition show={mobileOpen} as={Fragment}>
        <Dialog onClose={setMobileOpen} className="relative z-50 md:hidden">
          <TransitionChild
            as={Fragment}
            enter="ease-out duration-150"
            enterFrom="opacity-0"
            enterTo="opacity-100"
            leave="ease-in duration-100"
            leaveFrom="opacity-100"
            leaveTo="opacity-0"
          >
            <DialogBackdrop className="fixed inset-0 bg-black/50" />
          </TransitionChild>
          <TransitionChild
            as={Fragment}
            enter="ease-out duration-200"
            enterFrom="-translate-x-full"
            enterTo="translate-x-0"
            leave="ease-in duration-150"
            leaveFrom="translate-x-0"
            leaveTo="-translate-x-full"
          >
            <DialogPanel className="fixed inset-y-0 left-0 w-72 border-r bg-surface [border-color:rgb(var(--hairline))]">
              <Rail pathname={pathname} onNavigate={() => setMobileOpen(false)} />
            </DialogPanel>
          </TransitionChild>
        </Dialog>
      </Transition>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-canvas/80 px-4 backdrop-blur [border-color:rgb(var(--hairline))]">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open navigation"
            className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius)] text-secondary hover:bg-surface-hover hover:text-primary md:hidden"
          >
            <MenuIcon size={18} />
          </button>
          <div className="flex-1" />
          <PlatformHealthPill />
          <ThemeToggleButton />
          <span
            data-testid="platform-role-badge"
            className="hidden rounded-full border px-2 py-0.5 text-[11px] font-medium text-secondary sm:inline [border-color:rgb(var(--hairline))]"
          >
            {role === "PLATFORM_OWNER" ? "Owner" : "Support"}
          </span>
          <span className="hidden text-[13px] text-secondary sm:block">{userEmail}</span>
          <form action={signOutAction}>
            <button
              type="submit"
              title="Sign out"
              className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius)] text-secondary hover:bg-surface-hover hover:text-primary"
            >
              <LogOut size={17} />
            </button>
          </form>
        </header>

        <main className="flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
