"use client";

import type { ReactNode } from "react";
import { Tabs } from "@/components/ui/tabs";
import { IdentityTab } from "./identity-tab";
import { BillingTab } from "./billing-tab";
import { LifecycleTab } from "./lifecycle-tab";
import { GatewayTab } from "./gateway-tab";
import { SupportTab } from "./support-tab";
import { UsersTab } from "./users-tab";
import { GeoTab } from "./geo-tab";
import { ExtensionsTab } from "./extensions-tab";
import { TAB_SLUGS, type SerialisedTenantDetail, type PlatformRole, type TabSlug } from "./types";

// Tab container. The order matters: identity first (what IS this tenant),
// then billing and lifecycle (the things an operator came here to change),
// then gateway and support (the things they came here to diagnose), then
// users and geo (owner-only tenant administration).
//
// `initialTab` exists so the overview's attention queue can deep-link to the
// exact tab that fixes an item. An item that dumps the operator on a page and
// leaves them to find the right tab has only moved the hunt, not ended it.
//
// `ownerOnly` tabs are ABSENT from the list for a PLATFORM_SUPPORT operator,
// not merely disabled — same reasoning the page-level comment gives for
// owner-only actions elsewhere on this page: a visible-but-greyed-out tab
// still teaches someone it exists.

function buildTabs(
  detail: SerialisedTenantDetail,
  role: PlatformRole,
): Array<{ slug: TabSlug; label: string; ownerOnly?: boolean; content: ReactNode }> {
  return [
    { slug: "identity", label: "Identity", content: <IdentityTab detail={detail} role={role} /> },
    { slug: "billing", label: "Billing", content: <BillingTab detail={detail} role={role} /> },
    { slug: "lifecycle", label: "Lifecycle", content: <LifecycleTab detail={detail} role={role} /> },
    { slug: "gateway", label: "Gateway", content: <GatewayTab detail={detail} role={role} /> },
    { slug: "support", label: "Support access", content: <SupportTab detail={detail} /> },
    { slug: "users", label: "Users", ownerOnly: true, content: <UsersTab detail={detail} role={role} /> },
    { slug: "geo", label: "Geo", ownerOnly: true, content: <GeoTab detail={detail} role={role} /> },
    {
      slug: "extensions",
      label: "Extensions",
      ownerOnly: true,
      content: <ExtensionsTab detail={detail} role={role} />,
    },
  ];
}

export function TenantDetailTabs({
  detail,
  role,
  initialTab,
}: {
  detail: SerialisedTenantDetail;
  role: PlatformRole;
  initialTab?: string;
}) {
  const visible = buildTabs(detail, role).filter((t) => !t.ownerOnly || role === "PLATFORM_OWNER");

  const requested = (initialTab ?? "identity") as TabSlug;
  const index = Math.max(
    0,
    visible.findIndex((t) => t.slug === (TAB_SLUGS.includes(requested) ? requested : "identity")),
  );

  return (
    <Tabs
      defaultIndex={index}
      tabs={visible.map((t) => ({ label: t.label, content: t.content }))}
    />
  );
}
