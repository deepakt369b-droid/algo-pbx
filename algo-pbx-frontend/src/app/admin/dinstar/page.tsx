"use client";

import { Tabs } from "@/components/ui";
import { GatewayTab } from "@/components/telephony/gateway-tab";
import { ExtensionsTab } from "@/components/telephony/extensions-tab";

// Telephony hub. Merges the former standalone /admin/dinstar (gateway
// setup wizard) and /admin/extensions (extension/trunk provisioning) pages
// into one tabbed page, following the same <Tabs> pattern
// /admin/reports/page.tsx already established (Telephony/CRM Insights
// tabs there; Gateway/Extensions here). /admin/extensions now redirects
// here — see that page.
export default function DinstarPage() {
  return (
    <div className="flex w-full flex-col items-center gap-6">
      <h1 className="text-xl font-semibold text-primary">Telephony</h1>

      <Tabs
        tabs={[
          { label: "Gateway", content: <GatewayTab /> },
          { label: "Extensions", content: <ExtensionsTab /> },
        ]}
      />
    </div>
  );
}
