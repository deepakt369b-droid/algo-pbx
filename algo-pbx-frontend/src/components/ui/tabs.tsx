"use client";

import type { ReactNode } from "react";
import { TabGroup, TabList, Tab, TabPanels, TabPanel } from "@headlessui/react";
import { cn } from "@/lib/utils";

export function Tabs({
  tabs,
  className,
  defaultIndex,
}: {
  tabs: { label: string; content: ReactNode }[];
  className?: string;
  /** Which tab opens first. Additive and optional — existing callers are
   * unaffected. Needed so a deep link can land on a specific tab (the
   * platform console's attention queue links to ?tab=billing and friends,
   * and an item that opened the wrong tab would defeat the point of
   * linking at all). */
  defaultIndex?: number;
}) {
  return (
    <TabGroup className={className} defaultIndex={defaultIndex}>
      <TabList className="flex gap-1 border-b [border-color:rgb(var(--hairline))]">
        {tabs.map((t) => (
          <Tab
            key={t.label}
            className={cn(
              "-mb-px rounded-t-[var(--radius-sm)] border-b-2 border-transparent px-3 py-2 text-sm font-medium text-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset [--tw-ring-color:rgb(var(--ring))]",
              "hover:text-primary data-[selected]:border-accent data-[selected]:text-primary",
            )}
          >
            {t.label}
          </Tab>
        ))}
      </TabList>
      <TabPanels className="pt-4">
        {tabs.map((t) => (
          <TabPanel key={t.label} className="focus-visible:outline-none">
            {t.content}
          </TabPanel>
        ))}
      </TabPanels>
    </TabGroup>
  );
}
