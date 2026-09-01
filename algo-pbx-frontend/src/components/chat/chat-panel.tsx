"use client";

import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { ConversationList } from "./conversation-list";
import { ChatThread } from "./chat-thread";
import { WhatsAppConnectionBadge } from "./whatsapp-connection-badge";
import {
  resolveWhatsAppConversation,
  createWhatsAppConversationWithInstance,
  type WhatsAppDeepLinkResult,
} from "@/lib/messaging/whatsapp-deep-link";

type Phase =
  | { kind: "idle" }
  | { kind: "resolving" }
  | { kind: "creating" }
  | WhatsAppDeepLinkResult;

// Top-level chat surface wired into agent/chat/page.tsx: WhatsApp-Web
// geometry — a conversation-list rail on the left, the thread on the right.
// Below 768px it collapses to a single pane: the list, or the thread with a
// back arrow, never both.
//
// WhatsApp pairing/logout are out of scope here (they live in
// src/app/admin/whatsapp); this panel only reads and sends on conversations
// already assigned or claimable by the signed-in agent. The connection
// badge is read-only.
//
// The CRM "WhatsApp" deep-link entry (?number=<E164>) is rendering only —
// every branch of resolve/create/no-instance lives in
// src/lib/messaging/whatsapp-deep-link.ts.
export function ChatPanel({ initialNumber }: { initialNumber?: string } = {}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [contactLabel, setContactLabel] = useState<string | undefined>();
  const [phase, setPhase] = useState<Phase>(
    initialNumber ? { kind: "resolving" } : { kind: "idle" }
  );

  useEffect(() => {
    if (!initialNumber) {
      setPhase({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setPhase({ kind: "resolving" });
    resolveWhatsAppConversation(initialNumber).then((result) => {
      if (!cancelled) setPhase(result);
    });
    return () => {
      cancelled = true;
    };
  }, [initialNumber]);

  useEffect(() => {
    if (phase.kind === "found") setSelectedId(phase.conversationId);
  }, [phase]);

  const createWithInstance = async (waInstanceId: string) => {
    if (!initialNumber) return;
    setPhase({ kind: "creating" });
    const result = await createWhatsAppConversationWithInstance(initialNumber, waInstanceId);
    setPhase(result);
  };

  const handleSelect = (id: string, label?: string) => {
    setSelectedId(id);
    setContactLabel(label);
  };

  const backToList = () => {
    setSelectedId(null);
    if (phase.kind !== "idle") setPhase({ kind: "idle" });
  };

  // A "panel" phase renders in the thread column instead of a thread.
  const phasePanel =
    phase.kind === "resolving" || phase.kind === "creating" ? (
      <PanelShell tone="muted">
        {phase.kind === "creating" ? "Starting conversation…" : "Opening conversation…"}
      </PanelShell>
    ) : phase.kind === "error" ? (
      <PanelShell tone="danger">{phase.message}</PanelShell>
    ) : phase.kind === "no-instance-agent" ? (
      <PanelShell tone="warning">
        No WhatsApp line assigned to your account — ask your admin.
      </PanelShell>
    ) : phase.kind === "no-instance-admin" ? (
      <PanelShell tone="muted">
        <p className="mb-3 text-sm text-secondary">Choose a SIM line to send from:</p>
        {phase.instances.length === 0 ? (
          <p className="text-xs text-tertiary">No WhatsApp-capable SIM ports are configured yet.</p>
        ) : (
          <div className="flex flex-wrap justify-center gap-2">
            {phase.instances.map((inst) => (
              <button
                key={inst.id}
                onClick={() => createWithInstance(inst.id)}
                className="rounded-[var(--radius)] border px-3 py-1.5 text-xs text-primary hover:border-accent hover:text-accent"
              >
                {inst.label || `SIM ${inst.simPort}`}
              </button>
            ))}
          </div>
        )}
      </PanelShell>
    ) : null;

  const threadArea = phasePanel ?? (
    selectedId ? (
      <ChatThread conversationId={selectedId} contactLabel={contactLabel} onBack={backToList} />
    ) : (
      <PanelShell tone="muted">Select a conversation</PanelShell>
    )
  );

  // On mobile, "thread view" is active whenever a thread or a phase panel is showing.
  const threadOpen = !!selectedId || phasePanel !== null;

  return (
    <div className="flex h-full min-h-0 w-full flex-col gap-2">
      <WhatsAppConnectionBadge />
      <div className="flex min-h-0 flex-1 gap-3">
        <div
          className={cn(
            "min-h-0 w-full md:w-80 md:flex-shrink-0",
            threadOpen ? "hidden md:block" : "block"
          )}
        >
          <ConversationList selectedId={selectedId} onSelect={handleSelect} />
        </div>
        <div
          className={cn("min-h-0 min-w-0 flex-1", threadOpen ? "flex" : "hidden md:flex")}
        >
          {threadArea}
        </div>
      </div>
    </div>
  );
}

function PanelShell({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone: "muted" | "danger" | "warning";
}) {
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-1 flex-col items-center justify-center rounded-[var(--radius-lg)] border bg-surface p-6 text-center text-sm",
        tone === "danger" && "text-danger",
        tone === "warning" && "text-warning",
        tone === "muted" && "text-tertiary"
      )}
    >
      {children}
    </div>
  );
}
