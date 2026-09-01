"use client";

import { CrmCallProvider } from "@/components/crm/crm-call-context";
import { ScreenPop } from "@/components/crm/screen-pop";
import { CallPopover } from "@/components/crm/call-popover";
import { DispositionPrompt } from "@/components/crm/disposition-prompt";

// Node W's single mount point (per the plan: ONE addition to
// src/app/agent/layout.tsx, agent-shell.tsx untouched — S2b owns that).
// Wraps every agent page in CrmCallProvider so useCrmCall() works from the
// CRM's "Call" buttons, and renders the three always-on call-path surfaces:
// inbound screen-pop, the floating call popover, and the post-call
// disposition prompt. SIPProvider already wraps the shell from the root
// layout, so the live call survives navigation between these pages.
export function CrmCallLayer({ children }: { children: React.ReactNode }) {
  return (
    <CrmCallProvider>
      {children}
      <ScreenPop />
      <CallPopover />
      <DispositionPrompt />
    </CrmCallProvider>
  );
}
