"use client";

import { Tabs } from "@/components/ui/tabs";
import { IdentityTab } from "./identity-tab";
import { BillingTab } from "./billing-tab";
import { LifecycleTab } from "./lifecycle-tab";
import { GatewayTab } from "./gateway-tab";
import { SupportTab } from "./support-tab";
import type { SerialisedTenantDetail, PlatformRole } from "./types";

// Tab container. The order matters: identity first (what IS this tenant),
// then billing and lifecycle (the things an operator came here to change),
// then gateway and support (the things they came here to diagnose).
//
// `initialTab` exists so the overview's attention queue can deep-link to the
// exact tab that fixes an item. An item that dumps the operator on a page and
// leaves them to find the right tab has only moved the hunt, not ended it.

const TAB_SLUGS = ["identity", "billing", "lifecycle", "gateway", "support"] as const;

export function TenantDetailTabs({
  detail,
  role,
  initialTab,
}: {
  detail: SerialisedTenantDetail;
  role: PlatformRole;
  initialTab?: string;
}) {
  const index = Math.max(0, TAB_SLUGS.indexOf((initialTab ?? "identity") as (typeof TAB_SLUGS)[number]));

  return (
    <Tabs
      defaultIndex={index}
      tabs={[
        { label: "Identity", content: <IdentityTab detail={detail} role={role} /> },
        { label: "Billing", content: <BillingTab detail={detail} role={role} /> },
        { label: "Lifecycle", content: <LifecycleTab detail={detail} role={role} /> },
        { label: "Gateway", content: <GatewayTab detail={detail} role={role} /> },
        { label: "Support access", content: <SupportTab detail={detail} /> },
      ]}
    />
  );
}
