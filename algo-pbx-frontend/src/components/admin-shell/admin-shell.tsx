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
  Users2,
  Contact,
  UserCog,
  ListOrdered,
  Phone,
  AudioLines,
  Router,
  MessageCircle,
  MessageSquare,
  DoorOpen,
  BarChart3,
  Headphones,
  Ban,
  Globe,
  Settings,
  Activity,
  LogIn,
  FileCheck2,
  Menu as MenuIcon,
  LogOut,
} from "lucide-react";
import { useSessionIdentityGuard } from "@/lib/use-session-identity-guard";
import { SidebarNav, type NavGroup } from "@/components/shell/sidebar-nav";
import { ThemeToggleButton } from "@/components/shell/theme-toggle";
import { HealthPill } from "./health-pill";

// Two-level nav (plan §5 F4). Only routes that exist today — S2b/S6 add
// their own sub-cards (CRM pipeline/tasks/companies, monitor, recording).
const NAV: NavGroup[] = [
  { label: "Dashboard", items: [{ href: "/admin", label: "Wallboard", icon: LayoutDashboard }] },
  {
    label: "CRM",
    items: [
      { href: "/admin/contacts", label: "Contacts", icon: Contact },
      { href: "/admin/contact-ownership", label: "Ownership", icon: UserCog },
    ],
  },
  {
    label: "Telephony",
    items: [
      { href: "/admin/queues", label: "Queues", icon: ListOrdered },
      { href: "/admin/cdr", label: "Call log", icon: Phone },
      { href: "/admin/recordings", label: "Recordings", icon: AudioLines },
      { href: "/admin/extensions", label: "Extensions", icon: Router },
      { href: "/admin/dinstar", label: "Dinstar gateway", icon: Router },
    ],
  },
  {
    label: "Messaging",
    items: [
      { href: "/admin/whatsapp", label: "WhatsApp", icon: MessageCircle },
      { href: "/admin/sms", label: "SIM SMS", icon: MessageSquare },
      { href: "/admin/rooms", label: "Rooms", icon: DoorOpen },
    ],
  },
  { label: "Reports", items: [{ href: "/admin/reports", label: "Reports", icon: BarChart3 }] },
  {
    label: "Configuration",
    items: [
      { href: "/admin/users", label: "Users", icon: Users2 },
      { href: "/admin/escalations", label: "Manager escalation", icon: Headphones },
      { href: "/admin/dnc", label: "Do not call", icon: Ban },
      { href: "/admin/domain", label: "Connect domain", icon: Globe },
      { href: "/admin/settings", label: "Settings", icon: Settings },
      { href: "/admin/system", label: "System", icon: Activity },
    ],
  },
  {
    label: "Audit",
    items: [
      { href: "/admin/audit", label: "Audit log", icon: FileCheck2 },
      { href: "/admin/sign-ins", label: "Sign-ins", icon: LogIn },
    ],
  },
];

function Rail({ pathname, onNavigate }: { pathname: string; onNavigate?: () => void }) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center gap-2 border-b px-4 [border-color:rgb(var(--hairline))]">
        <span className="text-[15px] font-semibold tracking-tight text-primary">Algo PBX</span>
      </div>
      <SidebarNav groups={NAV} pathname={pathname} onNavigate={onNavigate} />
    </div>
  );
}

export function AdminShell({
  children,
  userId,
  userEmail,
  signOutAction,
}: {
  children: React.ReactNode;
  userId?: string | null;
  userEmail?: string | null;
  signOutAction: () => Promise<void>;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  // An agent signing in on this same browser replaces the session cookie for
  // every tab — force a re-render for whoever the cookie now belongs to
  // (the /admin/users table shows plaintext passwords by the owner's design).
  useSessionIdentityGuard(userId);

  return (
    <div className="flex min-h-screen bg-canvas text-primary">
      {/* desktop rail */}
      <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r bg-surface md:block [border-color:rgb(var(--hairline))]">
        <Rail pathname={pathname} />
      </aside>

      {/* mobile drawer */}
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
          <HealthPill />
          <ThemeToggleButton />
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
