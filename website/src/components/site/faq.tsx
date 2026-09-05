"use client";

import { Disclosure, DisclosureButton, DisclosurePanel } from "@headlessui/react";
import { ChevronDown } from "lucide-react";
import { faq } from "@/content/site";

export function Faq() {
  return (
    <div className="mx-auto max-w-2xl divide-y divide-hairline">
      {faq.map((item) => (
        <Disclosure as="div" key={item.q} className="py-4">
          {({ open }) => (
            <>
              <DisclosureButton className="flex w-full items-center justify-between gap-4 text-left">
                <span className="text-base font-medium text-primary">{item.q}</span>
                <ChevronDown
                  size={18}
                  className={`shrink-0 text-tertiary transition-transform ${open ? "rotate-180" : ""}`}
                />
              </DisclosureButton>
              <DisclosurePanel className="mt-2 pr-8 text-sm text-secondary">
                {item.a}
              </DisclosurePanel>
            </>
          )}
        </Disclosure>
      ))}
    </div>
  );
}
