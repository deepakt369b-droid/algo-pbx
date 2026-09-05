"use client";

import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import {
  Disclosure,
  DisclosureButton,
  DisclosurePanel,
} from "@headlessui/react";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  badge?: number;
};
export type NavGroup = {
  label: string;
  items: NavItem[];
};

function isActive(pathname: string, href: string) {
  // Shell roots are exact; everything else is a prefix match so nested/detail
  // routes keep their parent highlighted. Without "/platform" here, the
  // console's Overview link would stay highlighted on every /platform/* page.
  if (href === "/admin" || href === "/agent" || href === "/platform") return pathname === href;
  return pathname === href || pathname.startsWith(href + "/");
}

function Badge({ n }: { n?: number }) {
  if (!n || n <= 0) return null;
  return (
    <span className="ml-auto inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 text-[10px] font-semibold text-accent-fg">
      {n > 99 ? "99+" : n}
    </span>
  );
}

/** Two-level collapsible nav shared by both shells (Fitts: 40px+ rows,
 * serial-position: caller orders the groups). Accessibility from Headless
 * UI Disclosure. */
export function SidebarNav({
  groups,
  pathname,
  onNavigate,
}: {
  groups: NavGroup[];
  pathname: string;
  onNavigate?: () => void;
}) {
  return (
    <nav className="flex flex-1 flex-col gap-1 overflow-y-auto px-2 py-3">
      {groups.map((group) => {
        const groupActive = group.items.some((i) => isActive(pathname, i.href));
        return (
          <Disclosure key={group.label} defaultOpen={groupActive}>
            {({ open }) => (
              <div className="mb-0.5">
                <DisclosureButton className="flex w-full items-center gap-1.5 rounded-[var(--radius)] px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-tertiary hover:text-secondary">
                  <ChevronRight
                    size={12}
                    className={cn("transition-transform", open && "rotate-90")}
                  />
                  {group.label}
                </DisclosureButton>
                <DisclosurePanel className="mt-0.5 flex flex-col gap-0.5">
                  {group.items.map(({ href, label, icon: Icon, badge }) => {
                    const active = isActive(pathname, href);
                    return (
                      <Link
                        key={href}
                        href={href}
                        onClick={onNavigate}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "flex items-center gap-3 rounded-[var(--radius)] px-3 py-2 text-[13px] transition-colors",
                          active
                            ? "bg-accent-subtle font-medium text-accent"
                            : "text-secondary hover:bg-surface-hover hover:text-primary",
                        )}
                      >
                        <Icon size={16} className="shrink-0" />
                        <span className="flex-1 truncate">{label}</span>
                        <Badge n={badge} />
                      </Link>
                    );
                  })}
                </DisclosurePanel>
              </div>
            )}
          </Disclosure>
        );
      })}
    </nav>
  );
}
