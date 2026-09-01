"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { ContactList } from "@/components/crm/contact-list";
import { ContactDetail } from "@/components/crm/contact-detail";

// P3 — the agent UI rehaul (LLM.md §28/29): /agent is now the CRM, the
// agent's main interface, per the operator's explicit spec. The former
// /agent (softphone) moved to /agent/call unchanged; Call/WhatsApp/Calls/
// Recordings are sibling pages, linked from agent-shell.tsx's nav.
//
// Built in Tailwind against the existing glass-card language, matching
// 100% of today's agent surface — NOT MUI. The plan's original "Phase M
// (MUI migration) runs before P3" ordering was deliberately reprioritized
// per the operator's explicit request to see the CRM now rather than
// after a multi-page migration; this page converts to MUI in Phase M like
// every other page, at zero extra cost (Tailwind stays installed until
// that phase's last page lands regardless).
//
// ?contact=<id> (LLM.md §31): the CRM-integration deep link every other
// agent page's "View in CRM" action lands on — auto-selects that contact
// on load instead of requiring a second click in the list.
export default function AgentCrmPage() {
  const searchParams = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(searchParams.get("contact"));
  const [refreshToken, setRefreshToken] = useState(0);

  return (
    <main className="p-8">
      <h1 className="mb-6 text-center text-xl font-semibold text-primary lg:text-left">Contacts</h1>
      <div className="mx-auto flex max-w-6xl flex-col gap-6 lg:flex-row lg:items-start">
        <ContactList selectedId={selectedId} onSelect={setSelectedId} refreshToken={refreshToken} />
        {selectedId ? (
          <ContactDetail contactId={selectedId} onChanged={() => setRefreshToken((n) => n + 1)} />
        ) : (
          <div className="glass-card flex flex-1 items-center justify-center p-10 text-sm text-tertiary">
            Select a contact, or create a new one.
          </div>
        )}
      </div>
    </main>
  );
}
